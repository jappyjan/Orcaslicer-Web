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
import { readFile, writeFile } from 'node:fs/promises';
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
