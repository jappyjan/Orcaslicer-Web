#!/usr/bin/env node
/**
 * M4 ACCEPTANCE — the phone half.
 *
 *   docker compose up -d api
 *   node test/e2e/plater.mjs                      # or --base-url http://host:8080
 *
 * The milestone's criterion, verbatim: **"a two-object plate arranged entirely on a phone
 * slices to the exact positions shown on screen."** So this drives the real app in a real
 * browser at 390 × 844 with touch emulation, puts two objects on the plate using only the
 * on-screen controls, slices for real, and then **parses the extrusion coordinates out of
 * the resulting G-code and compares them with the numbers the screen was showing**. An
 * eyeball check would not be evidence of anything.
 *
 * It also re-runs M3's two pixel-level rules (nothing overflows 390 px, every target is at
 * least 44 px) against the new screen, and asserts the plate preview is present and
 * non-blank in the served archive — which matters because VERIFIED DEVIATION #5 says the
 * slicer's own output has no `Metadata/plate_1.png` member at all.
 *
 * Playwright is resolved from wherever it happens to be installed (it is a development
 * tool, not a dependency of the product); Chromium comes from `PLAYWRIGHT_BROWSERS_PATH`.
 */

import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ].filter(Boolean);
  for (const id of candidates) {
    try {
      return require(id);
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    `could not load playwright (tried ${candidates.join(', ')}). Install it, or set PLAYWRIGHT_MODULE.`,
  );
}

const args = process.argv.slice(2);
const baseUrl = valueOf('--base-url') ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const headless = !args.includes('--headed');

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// --- the model under test ---------------------------------------------------

/**
 * A 20 mm box, with **real facet normals**.
 *
 * VERIFIED DEVIATION #11: admesh decides ASCII-vs-binary by looking for a byte > 127
 * within 128 bytes of offset 80. A box with zeroed normals has none at 10 mm or 15 mm and
 * dies with CLI_DATA_FILE_ERROR while the same box at 20 mm loads. Unit normals make it
 * deterministic — the same reason `apps/api/src/geometry/mesh.ts` computes them.
 */
function binaryStlBox(size) {
  const faces = [
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
    ],
    [
      [0, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
    ],
    [
      [0, 1, 0],
      [1, 1, 1],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    [
      [1, 0, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  ];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.write(`orcaslicer-web e2e box ${size}mm`, 0, 'ascii');
  buffer.writeUInt32LE(faces.length, 80);
  let offset = 84;
  for (const [a, b, c] of faces) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n) || 1;
    for (const component of n) {
      buffer.writeFloatLE(component / length, offset);
      offset += 4;
    }
    for (const vertex of [a, b, c]) {
      buffer.writeFloatLE(vertex[0] * size, offset);
      buffer.writeFloatLE(vertex[1] * size, offset + 4);
      buffer.writeFloatLE(vertex[2] * size, offset + 8);
      offset += 12;
    }
    offset += 2;
  }
  return buffer;
}

// --- G-code ------------------------------------------------------------------

/**
 * Extruding moves, grouped by layer.
 *
 * SPEC deviation #4: E values come out with no leading digit (`E.02345`) and arc fitting
 * turns a share of extrusions into G2/G3, so the naive `^G1 .*E[0-9]` finds a handful of
 * lines out of thousands.
 */
function extrusionsByLayer(gcode) {
  const layers = new Map();
  let x = null;
  let y = null;
  let z = 0;
  for (const line of gcode.split('\n')) {
    if (!/^G[0123] /.test(line)) continue;
    const zMatch = / Z(-?[\d.]+)/.exec(line);
    if (zMatch) z = Number.parseFloat(zMatch[1]);
    const xMatch = / X(-?[\d.]+)/.exec(line);
    const yMatch = / Y(-?[\d.]+)/.exec(line);
    if (xMatch) x = Number.parseFloat(xMatch[1]);
    if (yMatch) y = Number.parseFloat(yMatch[1]);
    const eMatch = / E(-?[\d.]*)/.exec(line);
    if (!eMatch || x === null || y === null) continue;
    const extruded = Number.parseFloat(eMatch[1]);
    if (!Number.isFinite(extruded) || extruded <= 0) continue;
    const key = Math.round(z * 100) / 100;
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push([x, y]);
  }
  return layers;
}

/** Split a layer's points into objects at the widest gap along X. */
function clusterByX(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let widest = { gap: 0, index: -1 };
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const gap = sorted[index + 1][0] - sorted[index][0];
    if (gap > widest.gap) widest = { gap, index };
  }
  const groups =
    widest.gap > 5 ? [sorted.slice(0, widest.index + 1), sorted.slice(widest.index + 1)] : [sorted];
  return groups.map((group) => ({
    minX: Math.min(...group.map((p) => p[0])),
    maxX: Math.max(...group.map((p) => p[0])),
    minY: Math.min(...group.map((p) => p[1])),
    maxY: Math.max(...group.map((p) => p[1])),
    count: group.length,
  }));
}

// --- assertions --------------------------------------------------------------

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? '[32mok[0m  ' : '[31mFAIL[0m';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

/**
 * The toolpath is a centreline: the outer wall of a 0.4 nozzle is inset by half a line
 * width (~0.21 mm) from the model's true edge. 0.35 mm accepts that and nothing else.
 */
const TOLERANCE_MM = 0.35;

// --- the run -----------------------------------------------------------------

async function main() {
  const { chromium } = loadPlaywright();

  const health = await fetch(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`the API is not answering at ${baseUrl} — run \`docker compose up -d api\``);
  }
  const info = await health.json();
  console.log(`\nOrcaSlicer ${info.engine.version} at ${baseUrl}\n`);

  const scratch = await mkdtemp(join(tmpdir(), 'plater-e2e-'));
  const modelPath = join(scratch, 'cube20.stl');
  await writeFile(modelPath, binaryStlBox(20));

  const browser = await chromium.launch({
    headless,
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
  // A phone, not a narrow desktop: touch events, a mobile user agent and a 3x DPR all
  // change what the app does, and hard constraint #5 is about this device.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  try {
    console.log('setup');
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('row-model').waitFor({ timeout: 60_000 });

    // Upload, entirely through the UI.
    await page.getByTestId('row-model').tap();
    await page.getByTestId('model-file-input').setInputFiles(modelPath);
    // The picker closes itself once the upload has finished and the model is chosen;
    // reading the row before that would read the empty state.
    await page.getByTestId('model-picker').waitFor({ state: 'detached', timeout: 120_000 });
    check(
      'model uploaded',
      (await page.getByTestId('row-model').innerText()).includes('cube20'),
      await page.getByTestId('row-model').innerText(),
    );

    await page.getByTestId('row-printer').tap();
    await page.getByTestId('printer-search').fill('X1 Carbon');
    await page.getByTestId('printer-BBL/Bambu Lab X1 Carbon').first().tap();
    await page.getByTestId('nozzle-0.4').tap();
    await page.getByTestId('row-process').waitFor();
    // The process and filament presets default themselves; wait for that to settle.
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="missing-step"]'),
      undefined,
      { timeout: 60_000 },
    );
    check('printer, nozzle and presets chosen', true);

    // --- the plater -------------------------------------------------------
    // There is no longer a screen to open: the plate *is* the app, behind the floating
    // panels, from the first paint. The workspace and its canvas are already up.
    console.log('\nplater');
    await page.getByTestId('plater').waitFor();
    await page.getByTestId('plater-canvas').waitFor();
    check(
      'the plate is the printer’s own, not a default',
      (await page.getByTestId('plate-summary').innerText()).includes('256 × 256 × 250 mm'),
      await page.getByTestId('plate-summary').innerText(),
    );
    check(
      'WebGL is rendering',
      await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="plater-canvas"]');
        return Boolean(canvas && canvas.width > 0 && canvas.getContext('webgl2'));
      }),
    );

    // Two objects: the second is made with the on-screen Duplicate control.
    await page.getByTestId('duplicate').tap();
    const rows = page.locator('[data-testid^="instance-i"]');
    check('two objects on the plate', (await rows.count()) === 2, `${await rows.count()} rows`);

    // --- the transform controls, which exist *instead of* a drag gizmo -----
    await rows.nth(0).tap();
    await page.getByTestId('mode-scale').tap();
    await page.getByTestId('scale-200').tap();
    check(
      'scale 200% doubles the object',
      (await page.getByTestId('scale-size').innerText()).startsWith('40 × 40 × 40'),
      await page.getByTestId('scale-size').innerText(),
    );
    await page.getByTestId('scale-100').tap();
    check(
      'and back to 100%',
      (await page.getByTestId('scale-size').innerText()).startsWith('20 × 20 × 20'),
    );
    await page.getByTestId('mode-rotate').tap();
    await page.getByTestId('lay-flat').tap();
    check(
      'lay flat leaves the object on the bed',
      (await page.getByTestId('plate-problem').count()) === 0,
    );

    // Auto-arrange, which is the engine's packer over HTTP, not a client-side one.
    const beforeArrange = await positionsOf(page, rows);
    await page.getByTestId('auto-arrange').tap();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="auto-arrange"]')?.textContent === 'Auto-arrange',
      undefined,
      { timeout: 60_000 },
    );
    const afterArrange = await positionsOf(page, rows);
    check(
      'auto-arrange moved the objects',
      JSON.stringify(beforeArrange) !== JSON.stringify(afterArrange),
      `${JSON.stringify(beforeArrange)} -> ${JSON.stringify(afterArrange)}`,
    );
    check(
      'auto-arrange produced a plate the slicer would accept',
      (await page.getByTestId('plate-problem').count()) === 0,
    );

    /** Move the currently selected object with the numeric fields in Move mode. */
    async function place(x, y) {
      await page.getByTestId('mode-move').tap();
      await page.getByTestId('field-x').fill(String(x));
      await page.getByTestId('field-y').fill(String(y));
      await page.getByTestId('field-x').blur();
      await page.getByTestId('field-y').blur();
    }

    // Known positions, chosen to be far apart, on the plate and clear of the excluded
    // corner. These are the numbers the G-code has to agree with.
    const wanted = [{ centre: [80, 100] }, { centre: [170, 160] }];
    await rows.nth(0).tap();
    await page.getByTestId('mode-rotate').tap();
    await page.getByTestId('field-rx').fill('0');
    await page.getByTestId('field-ry').fill('0');
    await page.getByTestId('field-rz').fill('0');
    await page.getByTestId('field-rz').blur();
    await place(wanted[0].centre[0], wanted[0].centre[1]);

    // The second object is turned a quarter turn. The plate description has no rotation
    // field, so this one only lands correctly if the API baked the transform into the
    // geometry it staged — the whole reason `apps/api/src/geometry/mesh.ts` exists.
    await rows.nth(1).tap();
    await page.getByTestId('mode-rotate').tap();
    await page.getByTestId('field-rz').fill('90');
    await page.getByTestId('field-rz').blur();
    await place(wanted[1].centre[0], wanted[1].centre[1]);

    // Read the positions back off the screen — this is "the positions shown on screen",
    // and everything below is compared with these, not with the numbers typed above.
    const onScreen = [];
    for (let index = 0; index < 2; index += 1) {
      await rows.nth(index).tap();
      await page.getByTestId('mode-move').tap();
      onScreen.push([
        Number(await page.getByTestId('field-x').inputValue()),
        Number(await page.getByTestId('field-y').inputValue()),
      ]);
    }
    console.log(`  on screen: ${onScreen.map(([x, y]) => `(${x}, ${y})`).join('  ')}`);
    check('the plate reports no problem', (await page.getByTestId('plate-problem').count()) === 0);

    // --- the touch gestures, on the real canvas ---------------------------
    // The canvas is the whole viewport now, so its own centre can be underneath the
    // dock. Gestures go to the middle of the *free* rectangle — the part no panel is
    // covering, which is what the workspace publishes as `--free-*`.
    const canvas = await freeRect(page);
    const before = await screenshotHash(page);
    // One finger orbits.
    await page.touchscreen.tap(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await drag(page, canvas.x + 120, canvas.y + 120, canvas.x + 40, canvas.y + 150);
    const afterOrbit = await screenshotHash(page);
    check('one-finger drag orbits the camera', before !== afterOrbit);
    // Two fingers pinch to zoom.
    await pinch(page, canvas, 1.6);
    const afterPinch = await screenshotHash(page);
    check('two-finger pinch zooms', afterOrbit !== afterPinch);
    // Neither gesture is allowed to have moved anything on the plate.
    await rows.nth(0).tap();
    await page.getByTestId('mode-move').tap();
    check(
      'camera gestures never move an object',
      Number(await page.getByTestId('field-x').inputValue()) === onScreen[0][0],
    );

    // --- the mobile rules -------------------------------------------------
    console.log('\nlayout at 390px');
    const overflow = await page.evaluate(() => {
      const wide = [];
      for (const element of document.querySelectorAll('body *')) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.right > 390.5) {
          wide.push(`${element.tagName}.${element.className}`.slice(0, 80));
        }
      }
      return {
        scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        wide: wide.slice(0, 5),
      };
    });
    check(
      'nothing overflows 390px',
      !overflow.scrolls && overflow.wide.length === 0,
      overflow.wide.join(' | '),
    );

    const small = await page.evaluate(() => {
      const offenders = [];
      const selector = 'button, a, input[type="range"], input[type="number"], [role="tab"]';
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.height < 44) offenders.push(`${element.tagName} ${Math.round(rect.height)}px`);
      }
      return offenders;
    });
    check('every touch target is at least 44px tall', small.length === 0, small.join(', '));

    // --- slice ------------------------------------------------------------
    console.log('\nslice');
    await page.getByTestId('slice-button').tap();
    await page.getByTestId('job-state').waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="job-state"]')?.textContent?.trim() === 'Done',
      undefined,
      { timeout: 600_000 },
    );
    check('the slice succeeded', true);

    // The preview upload is what makes the archive's thumbnail real; the UI says when it
    // has landed, so the download below is not a race.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="preview-status"]')?.dataset.state === 'done',
      undefined,
      { timeout: 120_000 },
    );
    check('the plate preview was written into the archive', true);

    const links = await page.evaluate(() => ({
      gcode: document.querySelector('[data-testid="download-gcode"]')?.getAttribute('href'),
      project: document.querySelector('[data-testid="download-project"]')?.getAttribute('href'),
    }));

    // --- the actual criterion ---------------------------------------------
    console.log('\ng-code vs. screen');
    const gcode = await (await fetch(new URL(links.gcode, baseUrl))).text();
    const layers = extrusionsByLayer(gcode);
    const keys = [...layers.keys()].sort((a, b) => a - b);
    const layer = layers.get(keys[Math.floor(keys.length / 2)]);
    const clusters = clusterByX(layer).sort((a, b) => a.minX - b.minX);
    check('two objects in the G-code', clusters.length === 2, `${clusters.length} clusters`);

    // MEASURED on 2.4.2: G-code coordinates are plate coordinates minus `extruder_offset`,
    // which is 0x2 on a BBL X1C. The plate does not apply it and the firmware does.
    const bed = await (
      await fetch(
        `${baseUrl}/plater/bed?model=${encodeURIComponent('Bambu Lab X1 Carbon')}&vendor=BBL&nozzle=0.4`,
      )
    ).json();
    const [offsetX, offsetY] = bed.extruderOffset;
    console.log(`  extruder_offset: ${offsetX}, ${offsetY} mm`);

    for (const [index, cluster] of clusters.entries()) {
      const [screenX, screenY] = onScreen[index];
      const centreX = (cluster.minX + cluster.maxX) / 2 + offsetX;
      const centreY = (cluster.minY + cluster.maxY) / 2 + offsetY;
      console.log(
        `  object ${index + 1}: screen (${screenX}, ${screenY}) mm  →  g-code centre (${centreX.toFixed(3)}, ${centreY.toFixed(3)}) mm  ` +
          `[${cluster.count} extrusions, ${(cluster.maxX - cluster.minX).toFixed(2)} × ${(cluster.maxY - cluster.minY).toFixed(2)} mm]`,
      );
      check(
        `object ${index + 1} X within ${TOLERANCE_MM} mm`,
        near(centreX, screenX, TOLERANCE_MM),
        `Δ ${(centreX - screenX).toFixed(3)} mm`,
      );
      check(
        `object ${index + 1} Y within ${TOLERANCE_MM} mm`,
        near(centreY, screenY, TOLERANCE_MM),
        `Δ ${(centreY - screenY).toFixed(3)} mm`,
      );
      check(
        `object ${index + 1} is a 20 mm cube`,
        near(cluster.maxX - cluster.minX, 20, 1) && near(cluster.maxY - cluster.minY, 20, 1),
      );
    }

    // --- the thumbnail ----------------------------------------------------
    console.log('\nthumbnail');
    const archive = new Uint8Array(
      await (await fetch(new URL(links.project, baseUrl))).arrayBuffer(),
    );
    const entries = unzipSync(archive);
    const png = entries['Metadata/plate_1.png'];
    check(
      'Metadata/plate_1.png is present',
      Boolean(png),
      `${Object.keys(entries).length} members`,
    );
    if (png) {
      check(
        'it is a PNG',
        png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      );
      check('it is not blank', png.byteLength > 2000, `${png.byteLength} bytes`);
      // A one-colour render compresses to almost nothing; a plate with two objects on it
      // does not. The size floor is the cheap, dependency-free version of "non-blank".
    }

    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error(`\nFAILED:\n${failed.map((entry) => `  - ${entry.name}`).join('\n')}`);
    process.exitCode = 1;
  }
}

/**
 * The part of the viewport no floating panel is covering, as a bounding box.
 *
 * Read from the custom properties the workspace publishes rather than measured, so this
 * agrees with the projection offset the scene is applying by construction.
 */
async function freeRect(page) {
  return page.evaluate(() => {
    // `data-detent` is on the workspace root, which is where the properties are set.
    const root = document.querySelector('[data-detent]') ?? document.documentElement;
    const style = getComputedStyle(root);
    const at = (name) => Number.parseFloat(style.getPropertyValue(name)) || 0;
    const top = at('--free-top');
    const left = at('--free-left');
    const width = window.innerWidth - left - at('--free-right');
    const height = window.innerHeight - top - at('--free-bottom');
    return { x: left, y: top, width, height };
  });
}

/** The x/y each object reports on screen, read through the Move fields. */
async function positionsOf(page, rows) {
  const out = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    await rows.nth(index).tap();
    await page.getByTestId('mode-move').tap();
    out.push([
      Number(await page.getByTestId('field-x').inputValue()),
      Number(await page.getByTestId('field-y').inputValue()),
    ]);
  }
  return out;
}

/** A pointer drag, as a finger. */
async function drag(page, fromX, fromY, toX, toY) {
  await page.touchscreen.tap(fromX, fromY);
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * step) / 8, fromY + ((toY - fromY) * step) / 8);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/** Two fingers, moving apart or together. Playwright has no pinch, so CDP does it. */
async function pinch(page, box, factor) {
  const client = await page.context().newCDPSession(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const start = 60;
  const end = start * factor;
  const touch = (offset) => [
    { x: cx - offset, y: cy, id: 1 },
    { x: cx + offset, y: cy, id: 2 },
  ];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(start) });
  for (let step = 1; step <= 6; step += 1) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: touch(start + ((end - start) * step) / 6),
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
  await page.waitForTimeout(150);
}

/** A cheap hash of the rendered canvas, to tell "the camera moved" from "it did not". */
async function screenshotHash(page) {
  const data = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="plater-canvas"]');
    return canvas ? canvas.toDataURL('image/png').slice(-2000) : '';
  });
  return data;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
