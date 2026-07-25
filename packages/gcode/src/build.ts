/**
 * Compiling one plate's G-code into `plate_N.preview.bin` + `plate_N.preview.json`.
 *
 * ---------------------------------------------------------------------------
 * Why two passes
 * ---------------------------------------------------------------------------
 * Positions are quantised onto a 65 536-step grid spanning the toolpath's own bounding
 * box, and the bounding box is only known once the last move has been read. The
 * alternatives were:
 *
 *   - hold every segment in memory until the box is known — 25 MB for the budget file
 *     plus the object overhead to build it, which is exactly the "never hold the whole
 *     model" failure this milestone exists to avoid, only on the server;
 *   - write 32-byte absolute-micrometre records in one pass — 78 % more bytes, forever,
 *     on every layer the phone loads;
 *   - take the grid from the header's `printable_area` — one pass and exact, but wrong
 *     for a custom bed shape, and it wastes resolution on the empty parts of the bed.
 *
 * So the file is read twice: once to measure, once to encode. The second read is served
 * from the page cache, and this happens once per job ever — the result is written next
 * to the job's artefacts and every later request is a static file read.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { LayerEncoder, quantisationFor } from './encode.js';
import {
  FEATURE_NAMES,
  PREVIEW_FORMAT,
  PREVIEW_VERSION,
  type PreviewIndex,
  SEGMENT_BYTES,
} from './format.js';
import { type ParseResult, type SegmentSink, parseGcode } from './parser.js';
import { lines } from './tokenize.js';

/** 1 MiB read buffer: big enough that syscall overhead vanishes, small enough to ignore. */
const READ_CHUNK_BYTES = 1024 * 1024;

export interface CompileOptions {
  /** The `.gcode` to read. */
  gcodePath: string;
  /** Where the layer chunks go. */
  binPath: string;
  /** Where the index goes. Written last, so its presence means the pair is complete. */
  indexPath: string;
  /** 1-based plate, recorded in the index. */
  plate: number;
  /** Artefact name of the source G-code, recorded in the index. */
  gcodeName: string;
  /** Chord tolerance for arc flattening, millimetres. */
  arcToleranceMm?: number;
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function emptyBounds(): Bounds {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function widen(bounds: Bounds, x: number, y: number, z: number): void {
  if (x < bounds.min[0]) bounds.min[0] = x;
  if (y < bounds.min[1]) bounds.min[1] = y;
  if (z < bounds.min[2]) bounds.min[2] = z;
  if (x > bounds.max[0]) bounds.max[0] = x;
  if (y > bounds.max[1]) bounds.max[1] = y;
  if (z > bounds.max[2]) bounds.max[2] = z;
}

function sourceLines(path: string): AsyncGenerator<string> {
  return lines(createReadStream(path, { highWaterMark: READ_CHUNK_BYTES }));
}

/** Pass one: the bounding box, and nothing else. */
async function measure(options: CompileOptions): Promise<{ bounds: Bounds; result: ParseResult }> {
  const bounds = emptyBounds();
  const sink: SegmentSink = {
    segment(x0, y0, z0, x1, y1, z1) {
      widen(bounds, x0, y0, z0);
      widen(bounds, x1, y1, z1);
    },
  };
  const result = await parseGcode(sourceLines(options.gcodePath), sink, {
    ...(options.arcToleranceMm === undefined ? {} : { arcToleranceMm: options.arcToleranceMm }),
  });
  return { bounds, result };
}

export async function compilePreview(options: CompileOptions): Promise<PreviewIndex> {
  const started = Date.now();
  const { bounds, result: measured } = await measure(options);

  const hasGeometry = Number.isFinite(bounds.min[0]) && measured.segments > 0;
  const min = hasGeometry ? bounds.min : ([0, 0, 0] as [number, number, number]);
  const max = hasGeometry ? bounds.max : ([0, 0, 0] as [number, number, number]);
  const quantisation = quantisationFor(min, max);

  // Pass two writes to a temporary name and is renamed into place at the end, so a
  // crashed or killed parse can never leave a half-written `.bin` that a later request
  // would happily serve byte ranges out of.
  const binTemp = `${options.binPath}.partial`;
  const out = createWriteStream(binTemp);
  const encoder = new LayerEncoder(quantisation);

  const offsets: number[] = [];
  let written = 0;

  const write = async (bytes: Uint8Array): Promise<void> => {
    if (bytes.byteLength === 0) return;
    // The view aliases the encoder's buffer, which is reused for the next layer, so it
    // has to be copied before an asynchronous write can be handed the reference.
    if (!out.write(Buffer.from(bytes.slice().buffer))) await once(out, 'drain');
    written += bytes.byteLength;
  };

  const sink: SegmentSink = {
    layerStart() {
      encoder.reset();
    },
    segment(x0, y0, z0, x1, y1, z1, widthMicrons, heightMicrons, feature, tool) {
      encoder.push(x0, y0, z0, x1, y1, z1, widthMicrons, heightMicrons, feature, tool);
    },
    async layerEnd() {
      offsets.push(written);
      await write(encoder.view());
    },
  };

  let result: ParseResult;
  try {
    result = await parseGcode(sourceLines(options.gcodePath), sink, {
      ...(options.arcToleranceMm === undefined ? {} : { arcToleranceMm: options.arcToleranceMm }),
    });
    out.end();
    await once(out, 'close');
  } catch (error) {
    out.destroy();
    throw error;
  }
  await rename(binTemp, options.binPath);

  // Layer 0 holds whatever the machine start G-code extruded before the first
  // `; CHANGE_LAYER` — on a Bambu profile that is a 585 mm prime line. It is kept when
  // it has content (it is real material on the bed) and dropped when it is empty, and
  // `firstObjectLayer` tells the client which of the two happened.
  const first = (result.layers[0]?.segments ?? 0) === 0 ? 1 : 0;
  const layers = result.layers.slice(first);
  const layerOffsets = offsets.slice(first);
  const firstObjectLayer = 1 - first;

  const index: PreviewIndex = {
    format: PREVIEW_FORMAT,
    version: PREVIEW_VERSION,
    endianness: 'little',
    segmentBytes: SEGMENT_BYTES,
    source: {
      gcode: options.gcodeName,
      plate: options.plate,
      bytes: written,
      firstObjectLayer,
      headerLayerCount: result.header.layerCount,
      nozzleDiameter: result.header.nozzleDiameter,
      filamentColours: result.header.filamentColours,
    },
    quantisation,
    bounds: { min, max },
    features: FEATURE_NAMES,
    tools: result.stats.tools,
    stats: {
      layers: layers.length,
      segments: result.segments,
      bytes: written,
      arcs: result.stats.arcs,
      arcSegments: result.stats.arcSegments,
      arcsUnsupportedPlane: result.stats.arcsUnsupportedPlane,
      segmentsWithoutFeature: result.stats.segmentsWithoutFeature,
      unparsedLines: result.stats.unparsedLines,
      parseMs: Date.now() - started,
    },
    layers: {
      z: layers.map((layer) => round(layer.z, 4)),
      height: layers.map((layer) => round(layer.height, 4)),
      count: layers.map((layer) => layer.segments),
      offset: layerOffsets,
      featureMask: layers.map((layer) => layer.featureMask),
    },
  };

  await writeFile(options.indexPath, JSON.stringify(index));
  return index;
}

/** Keep the index small: four decimals is a tenth of a micron of Z. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
