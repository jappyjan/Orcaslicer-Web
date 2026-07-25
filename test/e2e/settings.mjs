#!/usr/bin/env node
/**
 * M6 ACCEPTANCE — the phone half.
 *
 *   docker compose up -d api
 *   node test/e2e/settings.mjs                    # or --base-url http://host:8080
 *
 * The milestone's criterion is **"any option exposed by the schema is editable and
 * demonstrably affects the output G-code"**. `apps/api/src/settings.integration.test.ts`
 * proves the second half against the binary; this proves the first — that the whole route
 * from a thumb on a 390 px screen to a changed flag on the command line exists and works.
 *
 * So it drives the real app in a real browser at 390 × 844 with touch emulation: opens
 * settings, navigates 751 options with the three tools that make that possible (search, a
 * disclosure level, a category drill-down), changes a float, an enum and a boolean, checks
 * each is marked modified, reverts one, saves the rest as a named preset, slices, and then
 * **reads the resulting G-code back** to confirm the values it was slicing with.
 *
 * It also re-runs M3/M4's two pixel rules against the new screen — nothing overflows
 * 390 px, every target is at least 44 px — because a settings form is where a 390 px
 * column is most likely to break.
 */

import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** A 12 mm box with real facet normals — see deviation #11 and test/e2e/plater.mjs. */
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
  buffer.write(`orcaslicer-web m6 box ${size}mm`, 0, 'ascii');
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

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? '[32mok[0m  ' : '[31mFAIL[0m';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The value the slicer actually used, out of the G-code's own resolved config block. */
function configValue(gcode, key) {
  const match = new RegExp(`^; ${key} = (.*)$`, 'm').exec(gcode);
  return match === null ? null : match[1].trim();
}

function countLines(gcode, pattern) {
  return gcode.split('\n').filter((line) => pattern.test(line)).length;
}

/** Nothing may stick out of a 390 px column, and no target may be under 44 px. */
async function checkMobileRules(page, where) {
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
    `nothing overflows 390px (${where})`,
    !overflow.scrolls && overflow.wide.length === 0,
    overflow.wide.join(' | '),
  );

  const small = await page.evaluate(() => {
    const offenders = [];
    const selector = 'button, a, select, textarea, input:not([type="file"]), [role="tab"]';
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.height < 44) offenders.push(`${element.tagName} ${Math.round(rect.height)}px`);
    }
    return offenders;
  });
  check(
    `every touch target is at least 44px tall (${where})`,
    small.length === 0,
    small.join(', '),
  );
}

async function main() {
  const { chromium } = loadPlaywright();

  const health = await fetch(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`the API is not answering at ${baseUrl} — run \`docker compose up -d api\``);
  }
  const info = await health.json();
  console.log(`\nOrcaSlicer ${info.engine.version} at ${baseUrl}\n`);

  const scratch = await mkdtemp(join(tmpdir(), 'settings-e2e-'));
  const modelPath = join(scratch, 'box12.stl');
  await writeFile(modelPath, binaryStlBox(12));

  const browser = await chromium.launch({
    headless,
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
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

    await page.getByTestId('row-model').tap();
    await page.getByTestId('model-file-input').setInputFiles(modelPath);
    await page.getByTestId('model-picker').waitFor({ state: 'detached', timeout: 120_000 });

    await page.getByTestId('row-printer').tap();
    await page.getByTestId('printer-search').fill('X1 Carbon');
    await page.getByTestId('printer-BBL/Bambu Lab X1 Carbon').first().tap();
    await page.getByTestId('nozzle-0.4').tap();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="missing-step"]'),
      undefined,
      { timeout: 60_000 },
    );
    check('printer, nozzle and presets chosen', true);

    // --- the settings screen ----------------------------------------------
    console.log('\nsettings');
    // The 708 kB schema is NOT on the main path: it must not have been fetched yet.
    const beforeOpen = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((entry) => entry.name.includes('schema=1')),
    );
    check('the 708 kB schema was not fetched before settings were opened', !beforeOpen);

    await page.getByTestId('row-settings').tap();
    await page.getByTestId('settings-sheet').waitFor({ timeout: 60_000 });
    await page.getByTestId('settings-group-Quality').waitFor({ timeout: 60_000 });
    check('the sheet opens on categories, not on 751 fields', true);

    const groupCount = await page.locator('[data-testid^="settings-group-"]').count();
    console.log(`  ${groupCount} groups at the Simple level`);
    check('there are groups to drill into', groupCount >= 5, `${groupCount} groups`);

    await checkMobileRules(page, 'settings root');

    // --- 1. a float, found by drill-down -----------------------------------
    await page.getByTestId('settings-group-Quality').tap();
    const layerHeight = page.getByTestId('field-layer_height');
    await layerHeight.waitFor();
    const presetLayerHeight = await layerHeight.inputValue();
    check(
      'a field shows the PRESET value, not the compiled-in default',
      presetLayerHeight === '0.2',
      `layer_height = ${presetLayerHeight}`,
    );
    check(
      'and says which preset it came from',
      (await page.getByTestId('setting-layer_height').innerText()).includes('process preset'),
    );
    await layerHeight.fill('0.28');
    await layerHeight.blur();
    await page.getByTestId('modified-layer_height').waitFor();
    check('changing it marks the field modified', true);

    // --- 2. an enum, in the same category ----------------------------------
    const seam = page.getByTestId('field-seam_position');
    await seam.selectOption('back');
    await page.getByTestId('modified-seam_position').waitFor();
    check('an enum is a native picker and marks modified', true);

    await checkMobileRules(page, 'a category with fields');

    // --- 3. a boolean, found by search -------------------------------------
    await page.getByTestId('sheet-close').tap();
    await page.getByTestId('row-settings').tap();
    await page.getByTestId('settings-search').fill('arc fitting');
    // `enable_arc_fitting` is an `advanced` option and the level is still Simple, so the
    // search finds nothing — and says how many it is hiding rather than looking broken.
    await page.getByTestId('settings-empty').waitFor({ timeout: 30_000 });
    check(
      'a search hidden by the disclosure level offers a way out',
      (await page.getByTestId('settings-raise-level').innerText()).includes('more at the expert'),
      (await page.getByTestId('settings-raise-level').innerText()).trim(),
    );
    await page.getByTestId('settings-raise-level').tap();
    await page.getByTestId('setting-enable_arc_fitting').waitFor({ timeout: 30_000 });
    check('search then finds it', true);
    // Turning one OFF is the direction SPEC deviation #23 breaks a naive serialiser on.
    await page.getByTestId('field-enable_arc_fitting-off').tap();
    await page.getByTestId('modified-enable_arc_fitting').waitFor();
    check('a boolean can be turned off, and is marked modified', true);

    // --- the modified-only filter ------------------------------------------
    await page.getByTestId('settings-search').fill('');
    await page.getByTestId('modified-only').tap();
    const modified = await page.locator('[data-modified="true"]').count();
    check('the modified filter lists exactly what changed', modified === 3, `${modified} fields`);

    // --- revert one --------------------------------------------------------
    await page.getByTestId('revert-seam_position').tap();
    const afterRevert = await page.locator('[data-modified="true"]').count();
    check('revert clears exactly one field', afterRevert === 2, `${afterRevert} left`);

    // --- save the rest as a named user preset ------------------------------
    // Back to the root list: the filter is a view, not a mode you get stuck in.
    await page.getByTestId('modified-only').tap();
    await page.getByTestId('row-saved-settings').tap();
    await page.getByTestId('preset-name').fill('Fast draft');
    await page.getByTestId('preset-save').tap();
    await page.getByTestId('preset-name').waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="user-preset-"]').length > 0,
      undefined,
      { timeout: 30_000 },
    );
    check('a named user preset is saved server-side', true);
    await checkMobileRules(page, 'saved settings');

    await page.getByTestId('sheet-close').tap();
    const rowText = await page.getByTestId('row-settings').innerText();
    check('the setup screen reports the diff', rowText.includes('2 changes'), rowText.trim());

    // --- slice -------------------------------------------------------------
    console.log('\nslice');
    await page.getByTestId('slice-button').tap();
    await page.getByTestId('job-state').waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="job-state"]')?.textContent?.trim() === 'Done',
      undefined,
      { timeout: 600_000 },
    );
    check('the slice succeeded', true);

    const href = await page.evaluate(() =>
      document.querySelector('[data-testid="download-gcode"]')?.getAttribute('href'),
    );
    const gcode = await (await fetch(new URL(href, baseUrl))).text();

    // --- the criterion -----------------------------------------------------
    console.log('\ng-code vs. what the screen said');
    check(
      'layer_height reached the slicer as 0.28',
      configValue(gcode, 'layer_height') === '0.28',
      `; layer_height = ${configValue(gcode, 'layer_height')}`,
    );
    check(
      'enable_arc_fitting reached the slicer as 0 — the `=` form works',
      configValue(gcode, 'enable_arc_fitting') === '0',
      `; enable_arc_fitting = ${configValue(gcode, 'enable_arc_fitting')}`,
    );
    check(
      'the reverted enum did NOT reach the slicer',
      configValue(gcode, 'seam_position') === 'aligned',
      `; seam_position = ${configValue(gcode, 'seam_position')}`,
    );
    const arcs = countLines(gcode, /^G[23] /);
    check('and the arcs really are gone from the toolpaths', arcs < 20, `${arcs} G2/G3 moves`);
    const zHeights = new Set(
      gcode
        .split('\n')
        .filter((line) => line.startsWith('; Z_HEIGHT:'))
        .map((line) => line.slice('; Z_HEIGHT:'.length).trim()),
    );
    check(
      'the layers really are 0.28 mm apart',
      zHeights.has('0.76'),
      `${zHeights.size} distinct Z heights`,
    );

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

main().catch((error) => {
  console.error(`\n${error?.stack ?? error}`);
  process.exitCode = 1;
});
