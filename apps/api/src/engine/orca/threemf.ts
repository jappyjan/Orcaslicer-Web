/**
 * Reading and repairing the `.gcode.3mf` archive.
 *
 * The archive is a ZIP:
 *
 *   Metadata/plate_N.gcode           the actual G-code
 *   Metadata/plate_N.gcode.md5       its MD5, uppercase hex
 *   Metadata/slice_info.config       time / mass / length per plate  (XML)
 *   Metadata/project_settings.config fully resolved settings          (JSON)
 *   Metadata/model_settings.config   object placement                 (XML)
 *   3D/3dmodel.model
 *
 * VERIFIED DEVIATION #5: with `--min-save` there is no `Metadata/plate_N.png` at all —
 * absent, not blank. Any future thumbnail rewrite must handle a missing member.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { FilamentUsage, PlateStats } from '@orca-web/shared';
import { unzipSync, zipSync } from 'fflate';

export const SLICE_INFO_ENTRY = 'Metadata/slice_info.config';
export const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config';

export type ArchiveEntries = Record<string, Uint8Array>;

export async function readArchive(path: string): Promise<ArchiveEntries> {
  const bytes = await readFile(path);
  return unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** `Metadata/plate_1.gcode`, `Metadata/plate_2.gcode`, … in plate order. */
export function gcodeEntries(entries: ArchiveEntries): Array<{ name: string; plate: number }> {
  return Object.keys(entries)
    .map((name) => ({ name, match: /^Metadata\/plate_(\d+)\.gcode$/.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .map((item) => ({ name: item.name, plate: Number(item.match[1]) }))
    .sort((a, b) => a.plate - b.plate);
}

/** The archive carries an MD5 for each plate; cheap integrity check on extraction. */
export function verifyGcodeChecksum(entries: ArchiveEntries, gcodeName: string): boolean {
  const expected = entries[`${gcodeName}.md5`];
  const gcode = entries[gcodeName];
  if (!expected || !gcode) return true; // nothing to check against
  const actual = createHash('md5').update(gcode).digest('hex');
  return actual.toLowerCase() === decode(expected).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// slice_info.config
// ---------------------------------------------------------------------------

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let match = re.exec(tag);
  while (match !== null) {
    out[match[1] as string] = match[2] as string;
    match = re.exec(tag);
  }
  return out;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse the per-plate slice report.
 *
 * SPEC: do NOT parse G-code to compute time or material — the numbers are already here.
 * VERIFIED DEVIATION #6: `first_layer_time` is uninitialised garbage (values such as
 * 1.67e19 have been observed) and is deliberately never read.
 */
export function parseSliceInfo(xml: string): PlateStats[] {
  const plates: PlateStats[] = [];

  for (const plateXml of xml.split(/<plate>/).slice(1)) {
    const body = plateXml.split(/<\/plate>/)[0] ?? '';
    const metadata: Record<string, string> = {};
    for (const tag of body.match(/<metadata\b[^>]*\/>/g) ?? []) {
      const attrs = attributes(tag);
      if (attrs.key !== undefined) metadata[attrs.key] = attrs.value ?? '';
    }

    const filaments: FilamentUsage[] = (body.match(/<filament\b[^>]*\/>/g) ?? []).map((tag) => {
      const attrs = attributes(tag);
      return {
        id: Math.trunc(numberOr(attrs.id, 1)),
        type: attrs.type ?? null,
        colour: attrs.color ?? null,
        usedMetres: numberOr(attrs.used_m, 0),
        usedGrams: numberOr(attrs.used_g, 0),
      };
    });

    // Layer count is not published directly; `layer_ranges="0 99"` is a closed range of
    // 0-based layer indices, so the count is (max + 1). Callers fall back to the G-code
    // header when the element is missing.
    let maxLayer = -1;
    for (const tag of body.match(/<layer_filament_list\b[^>]*\/>/g) ?? []) {
      const ranges = attributes(tag).layer_ranges;
      if (ranges === undefined) continue;
      for (const part of ranges.trim().split(/\s+/)) {
        const value = Number.parseInt(part, 10);
        if (Number.isFinite(value)) maxLayer = Math.max(maxLayer, value);
      }
    }

    plates.push({
      index: Math.trunc(numberOr(metadata.index, plates.length + 1)),
      predictionSeconds: numberOr(metadata.prediction, 0),
      weightGrams: numberOr(metadata.weight, 0),
      layerCount: maxLayer >= 0 ? maxLayer + 1 : null,
      filaments,
      outside: metadata.outside === 'true',
      supportUsed: metadata.support_used === 'true',
    });
  }

  return plates;
}

/**
 * `; total layer number: N` from the G-code header.
 *
 * This is a header comment the slicer writes for us, not a computation over the
 * toolpaths — it is only used when slice_info.config carries no layer ranges.
 */
export function layerCountFromGcodeHeader(gcode: string): number | null {
  const match = /^; total layer number: *(\d+)/m.exec(gcode.slice(0, 64 * 1024));
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

// ---------------------------------------------------------------------------
// project_settings.config
// ---------------------------------------------------------------------------

export function readPrinterModel(entries: ArchiveEntries): string | undefined {
  const raw = entries[PROJECT_SETTINGS_ENTRY];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(decode(raw));
    if (parsed !== null && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>).printer_model;
      if (typeof value === 'string') return value;
    }
  } catch {
    /* an unreadable project_settings is the slicer's problem, not ours */
  }
  return undefined;
}

export interface PatchResult {
  patched: boolean;
  from: string | undefined;
  to: string;
}

/**
 * SPEC gotcha: `printer_model` inside an input 3MF's `Metadata/project_settings.config`
 * must match the machine profile's `printer_model`, or slicing fails or — worse —
 * silently misbehaves. When a project is re-targeted at a different printer we patch it
 * before slicing.
 *
 * Always writes to `destination`: the source may be a shared, content-addressed blob in
 * the model library and must never be mutated in place.
 */
export async function patchProjectPrinterModel(
  source: string,
  destination: string,
  printerModel: string,
): Promise<PatchResult> {
  const entries = await readArchive(source);
  const current = readPrinterModel(entries);
  if (current === printerModel) return { patched: false, from: current, to: printerModel };

  const raw = entries[PROJECT_SETTINGS_ENTRY];
  if (!raw) return { patched: false, from: current, to: printerModel };

  const settings = JSON.parse(decode(raw)) as Record<string, unknown>;
  settings.printer_model = printerModel;
  entries[PROJECT_SETTINGS_ENTRY] = new TextEncoder().encode(JSON.stringify(settings, null, 4));

  await writeFile(destination, zipSync(entries, { level: 6 }));
  return { patched: true, from: current, to: printerModel };
}

// ---------------------------------------------------------------------------
// Placement — reading back what `--arrange 1` decided
// ---------------------------------------------------------------------------

/** Nine numbers, row-major 3×3, plus a translation — the plate description's convention. */
export interface ObjectPlacement {
  /** `<metadata key="name">` from `model_settings.config`, i.e. the staged file name. */
  name: string;
  position: [number, number, number];
  rotation: [number, number, number, number, number, number, number, number, number];
}

/** 3MF's row-vector matrix: `v' = v · M`, twelve numbers, translation last. */
type Row12 = number[];

const ROW12_IDENTITY: Row12 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function row12(value: string | undefined): Row12 {
  if (value === undefined) return [...ROW12_IDENTITY];
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 12 && parts.every((n) => Number.isFinite(n))
    ? parts
    : [...ROW12_IDENTITY];
}

/** `inner` applied first, then `outer` — both in 3MF's row-vector convention. */
function composeRow12(outer: Row12, inner: Row12): Row12 {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1)
        sum += (inner[row * 3 + k] ?? 0) * (outer[k * 3 + column] ?? 0);
      out.push(sum);
    }
  }
  for (let column = 0; column < 3; column += 1) {
    let sum = outer[9 + column] ?? 0;
    for (let k = 0; k < 3; k += 1) sum += (inner[9 + k] ?? 0) * (outer[k * 3 + column] ?? 0);
    out.push(sum);
  }
  return out;
}

/**
 * Where each object ended up in an exported project 3MF.
 *
 * MEASURED against 2.4.2. The chain that has to be unwound is:
 *
 *   - `3D/3dmodel.model` holds `<build><item objectid transform>` — the instance.
 *   - each object is a `<components><component transform>` pointing at the mesh, and that
 *     transform is the *centring* offset applied when the file was loaded.
 *   - `Metadata/model_settings.config` records the same centring as `source_offset_x/y/z`,
 *     and the mesh itself was written out already shifted by it.
 *
 * So the mesh vertex the file on disk contained is `f`, the exported mesh holds
 * `f − source_offset`, and the placed vertex is `(f − source_offset) · component · item`.
 * Folding that back gives a transform in the plate description's own terms —
 * `rotation · f + position` — which is what makes an arranged layout something the client
 * can hand straight back as `pos_x`/`pos_y`/`pos_z`.
 */
export function readObjectPlacements(entries: ArchiveEntries): ObjectPlacement[] {
  const model = entries['3D/3dmodel.model'];
  if (!model) return [];
  const xml = decode(model);
  const settings = entries['Metadata/model_settings.config'];
  const meta = settings ? parseObjectMetadata(decode(settings)) : new Map();

  // objectid -> the centring transform of its single component (if it has one)
  const centring = new Map<string, Row12>();
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let match = objectRe.exec(xml);
  while (match !== null) {
    const id = attributes(match[1] as string).id;
    const component = /<component\b([^>]*)\/?>/.exec(match[2] as string);
    if (id !== undefined && component) {
      centring.set(id, row12(attributes(component[1] as string).transform));
    }
    match = objectRe.exec(xml);
  }

  const placements: ObjectPlacement[] = [];
  const itemRe = /<item\b([^>]*)\/?>/g;
  match = itemRe.exec(xml);
  while (match !== null) {
    const item = attributes(match[1] as string);
    const id = item.objectid;
    if (id !== undefined) {
      const composed = composeRow12(row12(item.transform), centring.get(id) ?? [...ROW12_IDENTITY]);
      const info = meta.get(id);
      const source = info?.sourceOffset ?? [0, 0, 0];
      // position = translation − source_offset · linear
      const position: [number, number, number] = [0, 1, 2].map((column) => {
        let value = composed[9 + column] as number;
        for (let k = 0; k < 3; k += 1) {
          value -= (source[k] as number) * (composed[k * 3 + column] as number);
        }
        return value;
      }) as [number, number, number];
      placements.push({
        name: info?.name ?? id,
        position,
        // Transposed: 3MF multiplies a row vector from the left, we multiply a column
        // vector from the right.
        rotation: [
          composed[0] as number,
          composed[3] as number,
          composed[6] as number,
          composed[1] as number,
          composed[4] as number,
          composed[7] as number,
          composed[2] as number,
          composed[5] as number,
          composed[8] as number,
        ],
      });
    }
    match = itemRe.exec(xml);
  }
  return placements;
}

function parseObjectMetadata(
  xml: string,
): Map<string, { name: string; sourceOffset: [number, number, number] }> {
  const out = new Map<string, { name: string; sourceOffset: [number, number, number] }>();
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let match = objectRe.exec(xml);
  while (match !== null) {
    const id = attributes(match[1] as string).id;
    const body = match[2] as string;
    if (id !== undefined) {
      const value = (key: string): string | undefined =>
        new RegExp(`<metadata key="${key}" value="([^"]*)"`).exec(body)?.[1];
      out.set(id, {
        name: value('name') ?? id,
        sourceOffset: [
          numberOr(value('source_offset_x'), 0),
          numberOr(value('source_offset_y'), 0),
          numberOr(value('source_offset_z'), 0),
        ],
      });
    }
    match = objectRe.exec(xml);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

export function plateThumbnailEntry(plate: number): string {
  return `Metadata/plate_${plate}.png`;
}

/** A PNG, by its signature. The rewrite endpoint accepts client bytes; this is the gate. */
export function isPng(data: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return data.length > 8 && signature.every((byte, index) => data[index] === byte);
}

/**
 * Put a plate preview into a `.gcode.3mf`.
 *
 * SPEC: "the blank thumbnail is our problem to solve" — the slicer needs OpenGL to render
 * one and there is no display server. VERIFIED DEVIATION #5 sharpens it: with `--min-save`
 * the member is **absent**, not blank, so this adds an entry rather than replacing one,
 * and `[Content_Types].xml` has to learn about the `png` extension at the same time or
 * the archive stops being a valid 3MF.
 *
 * Rewrites in place via a temporary file: a half-written archive must never be visible to
 * a download that arrives mid-rewrite.
 */
export async function writePlateThumbnail(
  archivePath: string,
  plate: number,
  png: Uint8Array,
): Promise<{ bytes: number; replaced: boolean }> {
  if (!isPng(png)) throw new Error('the thumbnail is not a PNG');
  const entries = await readArchive(archivePath);
  const name = plateThumbnailEntry(plate);
  const replaced = entries[name] !== undefined;
  entries[name] = png;

  const types = entries['[Content_Types].xml'];
  if (types) {
    const xml = decode(types);
    if (!/Extension="png"/i.test(xml)) {
      entries['[Content_Types].xml'] = new TextEncoder().encode(
        xml.replace(/<\/Types>/i, '<Default Extension="png" ContentType="image/png"/></Types>'),
      );
    }
  }

  const temporary = `${archivePath}.thumb`;
  const zipped = zipSync(entries, { level: 6 });
  await writeFile(temporary, zipped);
  await rename(temporary, archivePath);
  return { bytes: zipped.byteLength, replaced };
}
