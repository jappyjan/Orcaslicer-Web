/**
 * `@orca-web/gcode` — the M5 server-side half: G-code in, compact per-layer preview out.
 *
 * The format is defined in `format.ts` and explained in docs/GCODE-PREVIEW-FORMAT.md.
 * Nothing here renders anything; the client half of M5 owns three.js.
 */

export {
  FEATURE_NAMES,
  FeatureType,
  PREVIEW_FORMAT,
  PREVIEW_VERSION,
  QUANT_MAX,
  SEGMENT_BYTES,
  U16,
  U16_STRIDE,
  U8,
  dequantise,
  layerRange,
  type FeatureTypeValue,
  type LayerIndex,
  type PreviewBounds,
  type PreviewIndex,
  type PreviewSource,
  type PreviewStats,
  type Quantisation,
} from './format.js';

export { featureFromName, isKnownFeatureName } from './features.js';

export {
  DEFAULT_ARC_TOLERANCE_MM,
  MAX_ARC_SEGMENTS,
  chordCount,
  interpolateArc,
  type ArcMove,
  type PointSink,
} from './arcs.js';

export { LayerEncoder, decodeSegments, quantisationFor, type Segment } from './encode.js';

export {
  MAX_TOOL_INDEX,
  parseGcode,
  type GcodeHeader,
  type ParseOptions,
  type ParseResult,
  type ParseStats,
  type ParsedLayer,
  type SegmentSink,
} from './parser.js';

export {
  WordScanner,
  commentValue,
  configValue,
  isMarker,
  lines,
  parseSignedDecimal,
} from './tokenize.js';

export { compilePreview, type CompileOptions } from './build.js';
