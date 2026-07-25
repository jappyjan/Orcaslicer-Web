#!/usr/bin/env node
/**
 * M5 ACCEPTANCE — the budget, measured.
 *
 *   docker compose up -d api
 *   node test/e2e/budget-job.mjs                 # once; prints a job id
 *   node test/e2e/preview.mjs --job <id>         # as often as you like
 *   node test/e2e/preview.mjs                    # slices one first
 *
 * SPEC's M5 criterion, verbatim: **"a 40 MB G-code file must open on a 4 GB phone without
 * crashing the tab"** and **"the layer slider stays responsive while scrubbing"**. Neither
 * is checkable by looking at a laptop, so this run is arranged to be as close to that
 * sentence as a container can get:
 *
 *  - a **real 44 MB slice** (900 layers, 1.5 M segments, 26 MiB of compiled preview),
 *    produced by `budget-job.mjs`, not a cube and not a synthetic buffer;
 *  - a **390 x 844 touch viewport** at DPR 3 with a mobile user agent;
 *  - a **hard V8 heap cap** — see HEAP_CAP_MB below — so "it did not crash" means
 *    something instead of meaning "the box had 15 GB". The cap does not bound typed-array
 *    backing stores, which is why the instance buffers are measured separately;
 *  - frame timings sampled from `requestAnimationFrame` *while a finger drags the layer
 *    slider*, which is the thing the criterion actually names.
 *
 * It also re-runs M3/M4's two pixel rules on the new screen (nothing wider than 390 px,
 * every target at least 44 px) and proves VERIFIED DEVIATION #15 is applied to the drawn
 * geometry by decoding the same byte range independently and comparing.
 *
 * What it cannot show is stated in the report rather than papered over: this is SwiftShader
 * on a four-core container, so GPU time and thermal behaviour on a real phone are out of
 * reach. Everything measured here is main-thread and memory behaviour, which is what the
 * budget is about.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/**
 * The V8 old-space cap, in megabytes.
 *
 * Chrome sizes its heap limit from the device: on a 4 GB Android phone a renderer gets
 * roughly 256–512 MB of old space before an OOM kill, and the tab shares that with the
 * compositor, the parsed DOM and every other page in the process. 512 is the generous end
 * of that range — picking it means a pass here is not a pass bought with desktop memory,
 * and a failure would be a real failure on the target device rather than a scare.
 */
const HEAP_CAP_MB = 512;

const args = process.argv.slice(2);
const baseUrl = valueOf('--base-url') ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const headless = !args.includes('--headed');

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

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

// --- assertions --------------------------------------------------------------

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? '[32mok[0m  ' : '[31mFAIL[0m';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- the format, decoded independently ---------------------------------------

/**
 * Dequantise a byte range straight out of the `.bin`, with no client code involved.
 *
 * The point is independence: if the renderer and this agreed because they shared a bug,
 * the comparison below would prove nothing. 18-byte records, little-endian, positions and
 * width/height as one `Uint16Array` with a stride of 9 — docs/GCODE-PREVIEW-FORMAT.md.
 */
function decodeBounds(index, buffer, segments) {
  const u16 = new Uint16Array(buffer, 0, segments * 9);
  const [ox, oy, oz] = index.quantisation.origin;
  const [sx, sy, sz] = index.quantisation.scale;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < segments; i += 1) {
    const q = i * 9;
    for (const [a, b] of [
      [0, 3],
      [1, 4],
      [2, 5],
    ]) {
      const origin = [ox, oy, oz][a];
      const scale = [sx, sy, sz][a];
      for (const slot of [a, b]) {
        const mm = origin + u16[q + slot] * scale;
        if (mm < min[a]) min[a] = mm;
        if (mm > max[a]) max[a] = mm;
      }
    }
  }
  return { min, max };
}

// --- the run -----------------------------------------------------------------

async function main() {
  const { chromium } = loadPlaywright();

  const health = await fetch(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`the API is not answering at ${baseUrl} — run \`docker compose up -d api\``);
  }
  console.log(`\nOrcaSlicer ${(await health.json()).engine.version} at ${baseUrl}`);

  let jobId = valueOf('--job') ?? process.env.E2E_JOB;
  if (!jobId) {
    console.log('\nno --job given; slicing the budget model first');
    const out = execFileSync('node', ['test/e2e/budget-job.mjs', '--base-url', baseUrl], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    jobId = out.trim().split('\n').pop();
  }

  const job = await (await fetch(`${baseUrl}/jobs/${jobId}`)).json();
  const gcode = job.artifacts?.find((artifact) => artifact.role === 'gcode');
  if (!gcode) throw new Error(`job ${jobId} has no G-code artefact`);
  console.log(`\nbudget model: job ${jobId}`);
  check(
    'the source G-code is at least 40 MB',
    gcode.bytes >= 40e6,
    `${(gcode.bytes / 1e6).toFixed(1)} MB`,
  );

  const indexStart = Date.now();
  const index = await (await fetch(`${baseUrl}/jobs/${jobId}/preview/1`)).json();
  console.log(
    `  index: ${index.stats.layers} layers, ${index.stats.segments} segments, ` +
      `${(index.source.bytes / 1048576).toFixed(1)} MiB of .bin, ` +
      `compiled/served in ${Date.now() - indexStart} ms`,
  );

  const bed = await (
    await fetch(
      `${baseUrl}/plater/bed?model=${encodeURIComponent('Bambu Lab X1 Carbon')}&vendor=BBL&nozzle=0.4`,
    )
  ).json();
  console.log(`  extruder_offset: ${bed.extruderOffset.join(', ')} mm`);

  // --- the browser, constrained -------------------------------------------
  const browser = await chromium.launch({
    headless,
    args: [`--js-flags=--max-old-space-size=${HEAP_CAP_MB}`],
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
  page.on('crash', () => consoleErrors.push('THE TAB CRASHED'));

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Math.round(
      (metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576,
    );
  };
  /**
   * `ScriptDuration` is JavaScript; `TaskDuration` is everything the main thread did,
   * which in a GPU-less container includes rasterising the scene. Separating them is the
   * only way to say which half of a slow frame is the client's fault.
   */
  const timings = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
    return { script: value('ScriptDuration'), task: value('TaskDuration') };
  };
  let peakHeap = 0;
  const sampleHeap = async (label) => {
    const used = await heap();
    peakHeap = Math.max(peakHeap, used);
    if (label) console.log(`  heap after ${label}: ${used} MB (peak ${peakHeap} MB)`);
    return used;
  };

  try {
    // The preview needs a printer chosen, because `extruder_offset` and the plate come
    // from the machine preset and nothing in the G-code carries them.
    console.log('\nsetup');
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('row-printer').waitFor({ timeout: 60_000 });
    await page.getByTestId('row-printer').tap();
    await page.getByTestId('printer-search').fill('X1 Carbon');
    await page.getByTestId('printer-BBL/Bambu Lab X1 Carbon').first().tap();
    await page.getByTestId('nozzle-0.4').tap();
    await page.getByTestId('row-process').waitFor();
    check('printer and nozzle chosen', true);
    await sampleHeap('the setup screen');

    // --- opening the preview ------------------------------------------------
    console.log('\nopening the preview');
    const openedAt = Date.now();
    await page.goto(`${baseUrl}/#preview=${jobId}`, { waitUntil: 'commit' });
    await page.getByTestId('preview-canvas').waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid="preview-stats"]')?.dataset.loaded) > 0,
      undefined,
      // Polled on a timer rather than per animation frame: a big window can spend a whole
      // frame in the rasteriser, and a rAF-driven poll would starve behind it.
      { timeout: 120_000, polling: 250 },
    );
    const openMs = Date.now() - openedAt;
    const firstStats = await stats(page);
    console.log(
      `  first layer window on screen after ${openMs} ms ` +
        `(in-page first paint ${firstStats.firstPaintMs} ms after the scene was built)`,
    );
    check('a layer window paints', firstStats.loaded > 0, `${firstStats.loaded} layers`);
    check(
      'WebGL is rendering',
      await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="preview-canvas"]');
        return Boolean(canvas && canvas.width > 0 && canvas.getContext('webgl2'));
      }),
    );
    await sampleHeap('the first window');

    // --- only the window is held --------------------------------------------
    console.log('\nthe window, not the model');
    console.log(
      `  layers ${firstStats.first}–${firstStats.last} · ${firstStats.segments} segments · ` +
        `${(firstStats.bytes / 1024).toFixed(0)} KB fetched · ` +
        `${(firstStats.instanceBytes / 1048576).toFixed(1)} MB of instance data`,
    );
    check(
      'the whole model was never downloaded',
      firstStats.bytes < index.source.bytes / 10,
      `${(firstStats.bytes / 1024).toFixed(0)} KB of ${(index.source.bytes / 1048576).toFixed(1)} MiB`,
    );
    check(
      'only the visible layers are resident',
      firstStats.loaded <= firstStats.last - firstStats.first + 1,
      `${firstStats.loaded} of ${index.stats.layers}`,
    );

    // --- deviation #15, on the drawn geometry -------------------------------
    console.log('\nextruder_offset');
    const range = {
      start: index.layers.offset[firstStats.first],
      end:
        index.layers.offset[firstStats.last] +
        index.layers.count[firstStats.last] * index.segmentBytes -
        1,
    };
    const raw = await (
      await fetch(`${baseUrl}/jobs/${jobId}/preview/1/data`, {
        headers: { Range: `bytes=${range.start}-${range.end}` },
      })
    ).arrayBuffer();
    const decoded = decodeBounds(index, raw, (range.end - range.start + 1) / index.segmentBytes);
    const drawn = firstStats.world;
    console.log(
      `  g-code window: x ${decoded.min[0].toFixed(2)}…${decoded.max[0].toFixed(2)}  ` +
        `y ${decoded.min[1].toFixed(2)}…${decoded.max[1].toFixed(2)} mm`,
    );
    console.log(
      `  drawn        : x ${drawn[0].toFixed(2)}…${drawn[3].toFixed(2)}  ` +
        `y ${drawn[1].toFixed(2)}…${drawn[4].toFixed(2)} mm`,
    );
    // The drawn box extends half a line width either side of the centreline the G-code
    // names, so the comparison is against ±0.5 mm rather than exact equality.
    for (const [axis, name] of [
      [0, 'X'],
      [1, 'Y'],
    ]) {
      const expectedMin = decoded.min[axis] + bed.extruderOffset[axis];
      const expectedMax = decoded.max[axis] + bed.extruderOffset[axis];
      check(
        `${name} is the G-code plus extruder_offset`,
        Math.abs(drawn[axis] - expectedMin) < 0.5 && Math.abs(drawn[axis + 3] - expectedMax) < 0.5,
        `Δmin ${(drawn[axis] - expectedMin).toFixed(3)} mm, Δmax ${(drawn[axis + 3] - expectedMax).toFixed(3)} mm`,
      );
      // And the correction is not a rounding artefact: without it the picture would be off
      // by the offset itself, which on a stock X1C is 2 mm in Y.
      if (bed.extruderOffset[axis] !== 0) {
        check(
          `${name} would be wrong without it`,
          Math.abs(drawn[axis] - decoded.min[axis]) > 0.5,
          `${Math.abs(drawn[axis] - decoded.min[axis]).toFixed(2)} mm adrift if skipped`,
        );
      }
    }

    // --- colour modes --------------------------------------------------------
    console.log('\ncolour');
    const legendNames = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="preview-legend"] span')]
        .map((node) => node.textContent.trim())
        .filter(Boolean),
    );
    check(
      'the feature legend lists what is in the window',
      legendNames.some((name) => name.includes('wall')) &&
        legendNames.some((name) => name.includes('infill')),
      legendNames.join(', '),
    );
    const beforeColour = await canvasHash(page);
    await page.getByTestId('preview-colour-tool').tap();
    await page.waitForTimeout(200);
    check('colour by tool repaints', beforeColour !== (await canvasHash(page)));
    await page.getByTestId('preview-colour-feature').tap();
    await page.waitForTimeout(200);

    // --- the deepest window the UI allows ------------------------------------
    console.log('\nthe deepest window');
    await setSlider(page, 'preview-depth', 200);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="preview-loading"]') === null,
      undefined,
      // Polled on a timer rather than per animation frame: a big window can spend a whole
      // frame in the rasteriser, and a rAF-driven poll would starve behind it.
      { timeout: 120_000, polling: 250 },
    );
    const deep = await stats(page);
    console.log(
      `  ${deep.loaded} layers · ${deep.segments} segments · ` +
        `${(deep.bytes / 1048576).toFixed(1)} MB fetched · ` +
        `${(deep.instanceBytes / 1048576).toFixed(1)} MB of instance data`,
    );
    const deepHeap = await sampleHeap('a 200-layer window');
    check(
      'a 200-layer window stays inside the heap cap',
      deepHeap < HEAP_CAP_MB * 0.6,
      `${deepHeap} MB of ${HEAP_CAP_MB} MB`,
    );
    /*
     * `JSHeapUsedSize` does **not** include this, and neither does `--max-old-space-size`:
     * a `Float32Array`'s backing store lives outside V8's old space. So the flag guards the
     * failure mode the format exists to prevent — decoding 1.5 M segments into 1.5 M
     * JavaScript objects, which is ~200 MB of old space — while the thing that bounds the
     * instance buffers is the window cap in `apps/web/src/state/preview.ts`. Both are
     * needed, and reporting only the heap would flatter the result.
     */
    const deepTotal = deepHeap + (deep.instanceBytes * 2) / 1048576;
    console.log(
      `  total: ${deepHeap} MB heap + ${((deep.instanceBytes * 2) / 1048576).toFixed(1)} MB of ` +
        `instance buffers (JS and their GPU mirror) = ${deepTotal.toFixed(1)} MB`,
    );
    check(
      'the deepest window’s buffers fit a phone with room to spare',
      deepTotal < 128,
      `${deepTotal.toFixed(1)} MB, against 240 MB if the whole model were resident`,
    );
    await setSlider(page, 'preview-depth', 20);
    // Back to a default-sized window *before* timing anything: the 141-layer window is
    // still resident for a moment, and measuring the frames that release it would be
    // measuring the tail of the previous step.
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid="preview-stats"]')?.dataset.loaded) <= 21,
      undefined,
      { timeout: 60_000, polling: 250 },
    );

    // --- scrubbing ------------------------------------------------------------
    console.log('\nscrubbing');
    await page.evaluate(() => {
      window.__frames = [];
      window.__longTasks = [];
      window.__sampling = true;
      // Frame intervals say what the user sees; long tasks say how much of that is *our*
      // main-thread work. The distinction matters here because this container rasterises
      // in software (SwiftShader), so a frame interval includes work a phone's GPU would
      // do off-thread — but a long task is JavaScript, and it blocks a phone exactly as
      // much as it blocks this.
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
      let previous = performance.now();
      const tick = (now) => {
        window.__frames.push(now - previous);
        previous = now;
        if (window.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const slider = await page.getByTestId('preview-layer').boundingBox();
    const scrubStart = Date.now();
    const beforeScrub = await timings();
    // The slider runs down the right-hand edge of the viewport now, the way the desktop
    // build's does, so the drag follows its long axis rather than assuming a horizontal
    // one. Everything measured below — frames, long tasks, JavaScript time — is unchanged
    // by which way it points.
    const vertical = slider.height > slider.width;
    const along = vertical ? slider.height : slider.width;
    const pointAt = (distance) =>
      vertical
        ? [slider.x + slider.width / 2, slider.y + distance]
        : [slider.x + distance, slider.y + slider.height / 2];
    // Two passes across the full length of the slider — the whole 900-layer model, there
    // and back, at roughly the speed a thumb moves.
    for (let pass = 0; pass < 2; pass += 1) {
      const from = pass % 2 === 0 ? 6 : along - 6;
      const to = pass % 2 === 0 ? along - 6 : 6;
      await page.mouse.move(...pointAt(from));
      await page.mouse.down();
      for (let step = 1; step <= 30; step += 1) {
        await page.mouse.move(...pointAt(from + ((to - from) * step) / 30));
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    }
    const scrubMs = Date.now() - scrubStart;
    const afterScrub = await timings();
    const sampled = await page.evaluate(() => {
      window.__sampling = false;
      return { frames: window.__frames, longTasks: window.__longTasks };
    });
    const frames = sampled.frames.sort((a, b) => a - b);
    const longTasks = sampled.longTasks.sort((a, b) => a - b);
    const at = (values, p) =>
      values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * p))];
    const scriptMs = (afterScrub.script - beforeScrub.script) * 1000;
    const taskMs = (afterScrub.task - beforeScrub.task) * 1000;

    console.log(
      `  ${frames.length} frames while dragging: ` +
        `p50 ${at(frames, 0.5).toFixed(1)} ms · p90 ${at(frames, 0.9).toFixed(1)} ms · ` +
        `max ${frames.at(-1).toFixed(1)} ms`,
    );
    console.log(
      `  ${longTasks.length} long tasks · ` +
        `${scriptMs.toFixed(0)} ms of JavaScript out of ${taskMs.toFixed(0)} ms of main-thread ` +
        `work in ${scrubMs} ms of dragging`,
    );
    check(
      'the median frame is inside a 60 Hz budget while scrubbing',
      at(frames, 0.5) <= 20,
      `${at(frames, 0.5).toFixed(1)} ms`,
    );
    /*
     * The responsiveness criterion is asserted on **JavaScript time, not frame time**, and
     * the reason is worth stating plainly rather than burying in a tolerance.
     *
     * This container has no GPU. Chromium falls back to SwiftShader, which rasterises on
     * the same thread the gesture runs on, so a frame interval here includes work that a
     * phone's GPU does off-thread. MEASURED with a separate probe: a twenty-frame orbit of
     * a default window spends 17.58 s of main-thread time and **0.03 s** of it in
     * JavaScript — the client contributes about two parts in a thousand of what the frame
     * timings show. Asserting on frame time would therefore be asserting on SwiftShader.
     *
     * What *is* ours, and what would regress if the window loader started doing too much
     * on the main thread, is `ScriptDuration`. A budget of a fifth of the wall clock leaves
     * four fifths for input, layout and paint — and it is a real ceiling: dropping the
     * 8 ms build slicing pushes this straight through it.
     */
    check(
      'the client’s own JavaScript leaves the gesture its frames',
      scriptMs < scrubMs * 0.2,
      `${scriptMs.toFixed(0)} ms of JS in ${scrubMs} ms (${((scriptMs / scrubMs) * 100).toFixed(1)}%)`,
    );
    await sampleHeap('two passes over 900 layers');

    // Settling after the scrub proves the release path: the layers dragged through are
    // gone, not accumulated. Waited for rather than sampled once — the window the finger
    // stopped on is published the moment it is chosen, and the layers behind it are
    // released a beat later, so a single read can legitimately catch the two out of step.
    const released = await page
      .waitForFunction(
        () => {
          const data = document.querySelector('[data-testid="preview-stats"]')?.dataset;
          if (!data || document.querySelector('[data-testid="preview-loading"]')) return false;
          const span = Number(data.last) - Number(data.first) + 1;
          return Number(data.loaded) <= span;
        },
        undefined,
        { timeout: 30_000, polling: 250 },
      )
      .then(
        () => true,
        () => false,
      );
    const settled = await stats(page);
    check(
      'layers scrubbed past were released',
      released,
      `${settled.loaded} resident for a ${settled.last - settled.first + 1}-layer window, ` +
        `after visiting all ${index.stats.layers}`,
    );
    const afterScrubHeap = await sampleHeap('settling');
    check(
      'the heap did not grow with the layers visited',
      afterScrubHeap < HEAP_CAP_MB * 0.5,
      `${afterScrubHeap} MB of the ${HEAP_CAP_MB} MB cap`,
    );

    // --- the ±1 buttons, which are how a thumb hits one layer ---------------
    const before = (await stats(page)).last;
    await page.getByTestId('preview-layer-up').tap();
    await page.getByTestId('preview-layer-up').tap();
    check('the +1 button steps a single layer', (await stats(page)).last === before + 2);

    // --- the mobile rules ---------------------------------------------------
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

    // --- gestures ------------------------------------------------------------
    const canvas = await page.getByTestId('preview-canvas').boundingBox();
    const beforeOrbit = await canvasHash(page);
    await page.mouse.move(canvas.x + 120, canvas.y + 120);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(canvas.x + 120 - step * 10, canvas.y + 120 + step * 4);
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
    check('one-finger drag orbits the toolpath', beforeOrbit !== (await canvasHash(page)));

    check('the tab never crashed', !consoleErrors.includes('THE TAB CRASHED'));
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    console.log(
      `\nbudget: peak JS heap ${peakHeap} MB against a ${HEAP_CAP_MB} MB cap, ` +
        `for a ${(gcode.bytes / 1e6).toFixed(1)} MB G-code`,
    );
    check(
      `peak heap stays well inside the ${HEAP_CAP_MB} MB cap`,
      peakHeap < HEAP_CAP_MB * 0.6,
      `${peakHeap} MB`,
    );
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

/** Everything the screen publishes about the current window. */
async function stats(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-testid="preview-stats"]');
    const data = node.dataset;
    return {
      first: Number(data.first),
      last: Number(data.last),
      loaded: Number(data.loaded),
      segments: Number(data.segments),
      bytes: Number(data.bytes),
      instanceBytes: Number(data.instanceBytes),
      firstPaintMs: Number(data.firstPaintMs),
      world: data.world ? data.world.split(',').map(Number) : [],
    };
  });
}

/** Drag an `<input type=range>` to an exact value; a thumb cannot, a test should. */
async function setSlider(page, testId, value) {
  await page.evaluate(
    ([id, target]) => {
      const input = document.querySelector(`[data-testid="${id}"]`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, String(target));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testId, value],
  );
  await page.waitForTimeout(120);
}

/**
 * A cheap hash of the rendered canvas, to tell "it repainted" from "it did not".
 *
 * Taken as a compositor screenshot rather than with `toDataURL`, which would need
 * `preserveDrawingBuffer` on the renderer — a per-frame cost the whole app would pay so
 * that a test could read a pixel.
 */
async function canvasHash(page) {
  const png = await page.getByTestId('preview-canvas').screenshot();
  let hash = 0;
  for (let i = 0; i < png.length; i += 7) hash = (hash * 31 + png[i]) | 0;
  return `${png.length}:${hash}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
