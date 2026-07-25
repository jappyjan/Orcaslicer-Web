/**
 * The streaming G-code state machine.
 *
 * It consumes lines and pushes extrusion segments at a sink; it never builds a model, an
 * array of moves, or a string holding the file. Peak memory is one input chunk plus
 * whatever the sink retains, which is what lets a 42 MiB input parse in a server process
 * sized for slicing rather than for previewing.
 *
 * ---------------------------------------------------------------------------
 * The marker set, MEASURED against the pinned OrcaSlicer 2.4.2 binary
 * ---------------------------------------------------------------------------
 * SPEC's M5 brief expects `;TYPE:` for features and `;LAYER_CHANGE` / `;Z:` for layers.
 * Our binary emits none of those. What it actually writes is:
 *
 *     ; CHANGE_LAYER            layer boundary
 *     ; Z_HEIGHT: 0.2           print Z of the layer just opened
 *     ; LAYER_HEIGHT: 0.2       its thickness
 *     ; FEATURE: Outer wall     extrusion role, human-readable
 *     ; LINE_WIDTH: 0.393713    extrusion width for the following moves
 *     ; layer num/total_layer_count: 1/20
 *     ; WIPE_START / ; WIPE_END
 *
 * all with a leading space. A parser written against the brief's assumption produces a
 * single layer of untyped segments. `;TYPE:` and `;LAYER_CHANGE` are still accepted so
 * the parser is not Orca-2.4.2-only, but they are the fallback, not the expectation.
 *
 * ---------------------------------------------------------------------------
 * Traps this file exists to survive
 * ---------------------------------------------------------------------------
 *  - `E.02345` with no leading digit (SPEC deviation #4) — see tokenize.ts.
 *  - `G2`/`G3` arcs (SPEC deviation #4) — see arcs.ts.
 *  - `M82`/`M83` absolute vs relative extrusion, and `G92 E0` resets. Bambu process
 *    profiles use relative E (`use_relative_e_distances = 1`) and reset with `G92 E0` in
 *    the layer-change G-code; SPEC's own gotcha list says some community profiles do not
 *    work without that reset, so both modes are real inputs.
 *  - `G90`/`G91` absolute vs relative positioning: 2.4.2's machine start G-code switches
 *    to relative and back mid-file.
 *  - Bambu's `T1000` / `T1100` / `T255` pseudo-tools. MEASURED: they appear in the start
 *    and end G-code of every X1C slice and are NOT tool changes. Anything at or above
 *    `MAX_TOOL_INDEX` is ignored, so a naive `T(\d+)` does not colour the whole model as
 *    extruder 1000.
 */

import { type ArcMove, DEFAULT_ARC_TOLERANCE_MM, interpolateArc } from './arcs.js';
import { featureFromName } from './features.js';
import { FeatureType, type FeatureTypeValue } from './format.js';
import { WordScanner, commentValue, configValue, isMarker } from './tokenize.js';

/**
 * Highest tool index treated as a real extruder.
 *
 * Bambu machine G-code uses `T1000`, `T1100` and `T255` as control codes. No consumer
 * machine has 64 extruders, so the cut is unambiguous.
 */
export const MAX_TOOL_INDEX = 64;

/** Squared millimetres below which a move is "did not go anywhere". */
const MIN_LENGTH_SQ = 1e-9;

/** Header facts worth keeping. Everything else in the 600-line config block is ignored. */
export interface GcodeHeader {
  /** `; total layer number: N`. */
  layerCount: number | null;
  /** `nozzle_diameter`, first slot. Renderer fallback when `; LINE_WIDTH:` is absent. */
  nozzleDiameter: number | null;
  /** `filament_colour`, one `#RRGGBB` per slot, in tool order. */
  filamentColours: string[];
}

export interface ParsedLayer {
  /** Print Z, millimetres. */
  z: number;
  /** Layer thickness, millimetres. 0 when the slicer never said. */
  height: number;
  segments: number;
  /** Bit `1 << feature` for every `FeatureType` present. */
  featureMask: number;
}

export interface ParseStats {
  arcs: number;
  arcSegments: number;
  arcsUnsupportedPlane: number;
  segmentsWithoutFeature: number;
  unparsedLines: number;
  /** Highest tool index seen, plus one. Always at least 1. */
  tools: number;
}

export interface ParseResult {
  header: GcodeHeader;
  layers: ParsedLayer[];
  stats: ParseStats;
  segments: number;
}

/**
 * Where segments go.
 *
 * `segment` takes loose numbers rather than an object on purpose: at 1.4 million calls
 * for the budget file, one allocation per segment is one garbage collection per layer.
 */
export interface SegmentSink {
  layerStart?(index: number): void;
  segment(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    widthMicrons: number,
    heightMicrons: number,
    feature: FeatureTypeValue,
    tool: number,
  ): void;
  /** Awaited, so a sink writing to disk can apply backpressure. */
  layerEnd?(index: number, layer: ParsedLayer): void | Promise<void>;
}

export interface ParseOptions {
  /** Chord tolerance for arc flattening, millimetres. */
  arcToleranceMm?: number;
}

/** Header parsing stops here; past it the config block cannot appear. */
const CONFIG_SCAN_LIMIT = 4000;

export async function parseGcode(
  source: AsyncIterable<string>,
  sink: SegmentSink,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const arcTolerance = options.arcToleranceMm ?? DEFAULT_ARC_TOLERANCE_MM;
  const scanner = new WordScanner();

  const header: GcodeHeader = { layerCount: null, nozzleDiameter: null, filamentColours: [] };
  const layers: ParsedLayer[] = [];
  const stats: ParseStats = {
    arcs: 0,
    arcSegments: 0,
    arcsUnsupportedPlane: 0,
    segmentsWithoutFeature: 0,
    unparsedLines: 0,
    tools: 1,
  };

  // --- machine state -------------------------------------------------------
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let absolutePosition = true;
  let absoluteExtrusion = true;
  let arcPlaneIsXY = true;
  let tool = 0;
  let feature: FeatureTypeValue = FeatureType.Unknown;
  let widthMicrons = 0;
  let heightMicrons = 0;

  // --- layer state ---------------------------------------------------------
  // Layer 0 is opened eagerly and holds whatever the machine start G-code extrudes —
  // purge lines and nozzle-load lines are real deposited material and belong in the
  // preview. It is dropped at the end if it stayed empty, which is the usual case for
  // slicers that print no prime line.
  let layerIndex = 0;
  let layerZ = Number.NaN;
  let layerSegments = 0;
  let layerMask = 0;
  let layerMaxZ = 0;
  let lineNumber = 0;

  sink.layerStart?.(0);

  const closeLayer = async (): Promise<void> => {
    const layer: ParsedLayer = {
      z: Number.isFinite(layerZ) ? layerZ : layerMaxZ,
      height: heightMicrons / 1000,
      segments: layerSegments,
      featureMask: layerMask,
    };
    layers.push(layer);
    await sink.layerEnd?.(layerIndex, layer);
  };

  const emit = (nx: number, ny: number, nz: number): void => {
    const dx = nx - x;
    const dy = ny - y;
    const dz = nz - z;
    if (dx * dx + dy * dy + dz * dz < MIN_LENGTH_SQ) {
      x = nx;
      y = ny;
      z = nz;
      return;
    }
    sink.segment(x, y, z, nx, ny, nz, widthMicrons, heightMicrons, feature, tool);
    layerSegments += 1;
    layerMask |= 1 << feature;
    if (feature === FeatureType.Unknown) stats.segmentsWithoutFeature += 1;
    if (nz > layerMaxZ) layerMaxZ = nz;
    x = nx;
    y = ny;
    z = nz;
  };

  for await (const line of source) {
    lineNumber += 1;

    // MEASURED, and it cost an afternoon: the machine start/end G-code from a profile is
    // copied into the output VERBATIM, indentation included, so real extruding moves
    // arrive as `    G1 X65.000 E1.24726 F2015.5`. Branching on `line[0]` and treating a
    // leading space as "probably a comment" silently discards the prime line — 585 mm of
    // deposited material, 105 moves, invisible in every summary statistic because the
    // lines were consumed rather than counted. Leading whitespace is skipped first, and
    // the decision is made on the first character that is actually there.
    let head = 0;
    while (head < line.length) {
      const code = line.charCodeAt(head);
      if (code !== 0x20 && code !== 0x09) break;
      head += 1;
    }
    if (head >= line.length) continue;
    const first = line.charCodeAt(head);

    // -----------------------------------------------------------------------
    // Comments. Checked before words because every third line is one.
    // -----------------------------------------------------------------------
    if (first === 0x3b /* ; */) {
      const featureName = commentValue(line, 'FEATURE') ?? commentValue(line, 'TYPE');
      if (featureName !== undefined) {
        feature = featureFromName(featureName);
        continue;
      }

      if (isMarker(line, 'CHANGE_LAYER') || isMarker(line, 'LAYER_CHANGE')) {
        await closeLayer();
        layerIndex += 1;
        layerZ = Number.NaN;
        layerSegments = 0;
        layerMask = 0;
        layerMaxZ = z;
        sink.layerStart?.(layerIndex);
        continue;
      }

      const zHeight = commentValue(line, 'Z_HEIGHT') ?? commentValue(line, 'Z');
      if (zHeight !== undefined) {
        const value = Number.parseFloat(zHeight);
        if (Number.isFinite(value)) layerZ = value;
        continue;
      }

      const layerHeight = commentValue(line, 'LAYER_HEIGHT') ?? commentValue(line, 'HEIGHT');
      if (layerHeight !== undefined) {
        const value = Number.parseFloat(layerHeight);
        if (Number.isFinite(value) && value > 0) heightMicrons = Math.round(value * 1000);
        continue;
      }

      const lineWidth = commentValue(line, 'LINE_WIDTH') ?? commentValue(line, 'WIDTH');
      if (lineWidth !== undefined) {
        const value = Number.parseFloat(lineWidth);
        if (Number.isFinite(value) && value > 0)
          widthMicrons = Math.min(65535, Math.round(value * 1000));
        continue;
      }

      if (lineNumber <= CONFIG_SCAN_LIMIT) readHeader(line, header);
      continue;
    }

    // G, M and T, upper or lower case. Anything else is a line shape we do not model,
    // and the count of them is reported so "the parser quietly ignored a third of the
    // file" is a number in the index rather than a discovery in the browser.
    const upper = first & ~0x20;
    if (upper !== 0x47 /* G */ && upper !== 0x4d /* M */ && upper !== 0x54 /* T */) {
      stats.unparsedLines += 1;
      continue;
    }

    // -----------------------------------------------------------------------
    // Commands.
    // -----------------------------------------------------------------------
    scanner.reset(line);
    if (!scanner.next()) continue;
    const command = scanner.letter;
    const code = scanner.value;

    if (command === 'T') {
      // Bambu's T1000/T1100/T255 are control codes, not tool changes.
      if (Number.isInteger(code) && code >= 0 && code < MAX_TOOL_INDEX) {
        tool = code;
        if (tool + 1 > stats.tools) stats.tools = tool + 1;
      }
      continue;
    }

    if (command === 'M') {
      if (code === 82) absoluteExtrusion = true;
      else if (code === 83) absoluteExtrusion = false;
      continue;
    }

    if (command !== 'G') continue;

    if (code === 90) {
      absolutePosition = true;
      continue;
    }
    if (code === 91) {
      absolutePosition = false;
      continue;
    }
    if (code === 17) {
      arcPlaneIsXY = true;
      continue;
    }
    if (code === 18 || code === 19) {
      arcPlaneIsXY = false;
      continue;
    }

    if (code === 92) {
      // `G92 E0` — the extruder-position reset SPEC's gotcha list calls out. Without it,
      // absolute-E output looks like one continuous 10-kilometre extrusion.
      while (scanner.next()) {
        if (scanner.letter === 'E' && Number.isFinite(scanner.value)) e = scanner.value;
        else if (scanner.letter === 'X' && Number.isFinite(scanner.value)) x = scanner.value;
        else if (scanner.letter === 'Y' && Number.isFinite(scanner.value)) y = scanner.value;
        else if (scanner.letter === 'Z' && Number.isFinite(scanner.value)) z = scanner.value;
      }
      continue;
    }

    const isArc = code === 2 || code === 3;
    if (code !== 0 && code !== 1 && !isArc) continue;

    let nx = Number.NaN;
    let ny = Number.NaN;
    let nz = Number.NaN;
    let eWord = Number.NaN;
    let i = Number.NaN;
    let j = Number.NaN;
    let r = Number.NaN;

    while (scanner.next()) {
      const value = scanner.value;
      if (!Number.isFinite(value)) continue;
      switch (scanner.letter) {
        case 'X':
          nx = value;
          break;
        case 'Y':
          ny = value;
          break;
        case 'Z':
          nz = value;
          break;
        case 'E':
          eWord = value;
          break;
        case 'I':
          i = value;
          break;
        case 'J':
          j = value;
          break;
        case 'R':
          r = value;
          break;
        default:
          break;
      }
    }

    const targetX = Number.isFinite(nx) ? (absolutePosition ? nx : x + nx) : x;
    const targetY = Number.isFinite(ny) ? (absolutePosition ? ny : y + ny) : y;
    const targetZ = Number.isFinite(nz) ? (absolutePosition ? nz : z + nz) : z;

    // Extrusion. In relative mode the word IS the delta; in absolute mode it is the new
    // odometer reading and the delta is the difference. Either way, only a positive
    // delta lays material down: retractions, wipes-while-retracting and de-retractions
    // all carry E but deposit nothing.
    let extruded = 0;
    if (Number.isFinite(eWord)) {
      if (absoluteExtrusion) {
        extruded = eWord - e;
        e = eWord;
      } else {
        extruded = eWord;
        e += eWord;
      }
    }
    const extruding = code !== 0 && extruded > 0;

    if (!isArc) {
      if (extruding) emit(targetX, targetY, targetZ);
      else {
        x = targetX;
        y = targetY;
        z = targetZ;
      }
      continue;
    }

    // --- G2 / G3 -----------------------------------------------------------
    if (!arcPlaneIsXY) {
      // G18/G19 select the XZ/YZ plane. MEASURED: 2.4.2 only ever selects G17, so rather
      // than carry two more untested projections the chord is drawn and counted.
      stats.arcsUnsupportedPlane += 1;
      if (extruding) emit(targetX, targetY, targetZ);
      else {
        x = targetX;
        y = targetY;
        z = targetZ;
      }
      continue;
    }

    const arc: ArcMove = {
      x0: x,
      y0: y,
      z0: z,
      x1: targetX,
      y1: targetY,
      z1: targetZ,
      // I/J are always offsets from the current point, in both G90 and G91.
      i,
      j,
      r,
      clockwise: code === 2,
    };

    if (!extruding) {
      // A travel arc still moves the head, and the head's position is the start of the
      // next extrusion. Nothing is drawn, but the endpoint has to be taken.
      x = targetX;
      y = targetY;
      z = targetZ;
      continue;
    }

    const before = layerSegments;
    const chords = interpolateArc(arc, emit, arcTolerance);
    if (chords === 0) {
      // Degenerate arc: I and J both zero, or an R the endpoints cannot support. Draw
      // the chord so the extrusion is not lost.
      emit(targetX, targetY, targetZ);
    } else {
      stats.arcs += 1;
      stats.arcSegments += layerSegments - before;
    }
  }

  await closeLayer();

  const segments = layers.reduce((sum, layer) => sum + layer.segments, 0);
  return { header, layers, stats, segments };
}

/**
 * Pull the handful of useful facts out of the header and `CONFIG_BLOCK`.
 *
 * SPEC is explicit that time and material come from `slice_info.config` and are never
 * computed from G-code; nothing read here is either. These are rendering inputs: the
 * layer count is a cross-check on the layer index, the nozzle diameter is the width
 * fallback, and the filament colours are the per-tool palette.
 */
function readHeader(line: string, header: GcodeHeader): void {
  if (header.layerCount === null) {
    const total = commentValue(line, 'total layer number');
    if (total !== undefined) {
      const value = Number.parseInt(total, 10);
      if (Number.isFinite(value)) header.layerCount = value;
      return;
    }
  }
  if (header.nozzleDiameter === null) {
    const nozzle = configValue(line, 'nozzle_diameter');
    if (nozzle !== undefined) {
      const value = Number.parseFloat(nozzle.split(',')[0] ?? '');
      if (Number.isFinite(value) && value > 0) header.nozzleDiameter = value;
      return;
    }
  }
  if (header.filamentColours.length === 0) {
    const colours = configValue(line, 'filament_colour');
    if (colours !== undefined && colours !== '') {
      header.filamentColours = colours
        .split(/[;,]/)
        .map((entry) => entry.trim())
        .filter((entry) => /^#[0-9a-fA-F]{6,8}$/.test(entry));
    }
  }
}
