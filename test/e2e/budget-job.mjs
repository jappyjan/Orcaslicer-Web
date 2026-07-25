#!/usr/bin/env node
/**
 * Produce the M5 budget job: **a 40 MB G-code file**, sliced for real.
 *
 *   docker compose up -d api
 *   node test/e2e/budget-job.mjs            # prints the job id
 *   node test/e2e/budget-job.mjs --reuse    # reuse one that already exists
 *
 * SPEC's M5 budget is "a 40 MB G-code file must open on a 4 GB phone without crashing the
 * tab", and the point of this script is that the file is a *real slice* rather than a
 * synthetic worst case or a cube dressed up as one. It is a 90 mm solid box at 0.1 mm
 * layers and 25 % infill — the same shape the server-side half measured (see
 * docs/GCODE-PREVIEW-FORMAT.md, "Measurements"): ~42 MiB, 900 layers, 1.5 M segments,
 * 26 MiB of compiled preview.
 *
 * The output is **never committed**: 42 MiB of G-code has no business in git. It lives in
 * the API's own data volume as an ordinary job, which is also what makes it reusable —
 * `test/e2e/preview.mjs --job <id>` drives the browser at it as many times as you like
 * without re-slicing.
 *
 * VERIFIED DEVIATION #11: the STL below carries real facet normals. admesh sniffs
 * ASCII-vs-binary by looking for a byte > 127 within 128 bytes of offset 80, and a box
 * with zeroed normals is rejected outright at some sizes.
 */

const args = process.argv.slice(2);
const baseUrl = valueOf('--base-url') ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const reuse = args.includes('--reuse');
const size = Number(valueOf('--size') ?? 90);

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** A solid box with unit facet normals, as binary STL. */
export function binaryStlBox(size) {
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
  buffer.write(`orcaslicer-web m5 budget box ${size}mm`, 0, 'ascii');
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

const PRINTER = { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' };
// There is no stock "0.10mm" process for the X1C — the BBL ladder goes 0.08 / 0.12 / 0.16
// / 0.20 — so 0.1 mm layers come from an override on the nearest one.
const PROCESS = { kind: 'process', vendor: 'BBL', name: '0.12mm Fine @BBL X1C' };
const FILAMENT = { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL X1C' };

/**
 * Find a finished job whose plate 1 G-code is at least 40 MB.
 *
 * There is no job list endpoint, so "reuse" means an id handed in by the caller; this is
 * only the shape check.
 */
async function gcodeBytes(jobId) {
  const response = await fetch(`${baseUrl}/jobs/${jobId}`);
  if (!response.ok) return null;
  const job = await response.json();
  const gcode = job.artifacts?.find((artifact) => artifact.role === 'gcode');
  return job.state === 'succeeded' && gcode ? gcode.bytes : null;
}

async function main() {
  const health = await fetch(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`the API is not answering at ${baseUrl} — run \`docker compose up -d api\``);
  }

  const existing = valueOf('--job') ?? process.env.E2E_JOB;
  if (reuse && existing) {
    const bytes = await gcodeBytes(existing);
    if (bytes) {
      console.log(`reusing ${existing} (${(bytes / 1e6).toFixed(1)} MB)`);
      console.log(existing);
      return;
    }
  }

  const stl = binaryStlBox(size);
  console.error(`uploading a ${size} mm box (${stl.byteLength} B)…`);
  const form = new FormData();
  form.append('files', new Blob([stl]), `budget${size}.stl`);
  const upload = await fetch(`${baseUrl}/models`, { method: 'POST', body: form });
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const model = (await upload.json()).models[0];

  // `overrides` is the M6 hook; here it is the only way to ask for 25 % infill without
  // authoring a preset, and 25 % is what the server-side measurement used.
  const descriptor = {
    name: `M5 budget ${size}mm`,
    printer: PRINTER,
    process: PROCESS,
    filaments: [FILAMENT],
    overrides: { layer_height: 0.1, sparse_infill_density: '25%' },
    input: {
      kind: 'plates',
      plates: [
        { index: 1, arrange: true, objects: [{ model: { source: 'library', id: model.id } }] },
      ],
    },
  };
  const jobForm = new FormData();
  jobForm.append('descriptor', JSON.stringify(descriptor));
  const created = await fetch(`${baseUrl}/jobs`, { method: 'POST', body: jobForm });
  if (!created.ok) throw new Error(`POST /jobs failed: ${created.status} ${await created.text()}`);
  const { id } = await created.json();
  console.error(`job ${id} submitted; slicing 900 layers takes a few minutes…`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const job = await (await fetch(`${baseUrl}/jobs/${id}`)).json();
    if (job.state === 'succeeded') {
      const gcode = job.artifacts.find((artifact) => artifact.role === 'gcode');
      console.error(
        `done in ${((Date.now() - startedAt) / 1000).toFixed(0)} s — ` +
          `${gcode.name} is ${(gcode.bytes / 1e6).toFixed(1)} MB, ` +
          `${job.stats?.layerCount ?? '?'} layers`,
      );
      if (gcode.bytes < 40e6) {
        console.error(
          `WARNING: ${(gcode.bytes / 1e6).toFixed(1)} MB is under the 40 MB budget; ` +
            `re-run with a larger --size`,
        );
      }
      console.log(id);
      return;
    }
    if (job.state !== 'queued' && job.state !== 'running') {
      throw new Error(`job ${id} ended as ${job.state}: ${job.error?.message ?? ''}`);
    }
    process.stderr.write(`\r  ${job.state} ${Math.round(job.percent)}% ${job.message ?? ''}    `);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
