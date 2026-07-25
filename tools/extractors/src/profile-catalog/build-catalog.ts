/**
 * Deliverable 2 — walk `resources/profiles`, resolve every `inherits` chain, and emit a
 * flat, queryable catalog plus a report of anything that failed to resolve.
 *
 * ## What gets persisted
 *
 * Each preset is stored with **its own keys plus its resolved chain**, not with its
 * fully merged config. Merging is a cheap `Object.assign` over 1–5 objects at query
 * time ({@link ProfileCatalogQuery.resolve}); persisting merged copies would blow a
 * 20 MB profile tree up into hundreds of megabytes of duplicated G-code strings, for
 * no gain. Resolution itself still runs over *every* preset at build time, because
 * that is what produces the unresolved report and the compatibility index.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  catalogReportPath,
  ORCA_VERSION,
  profileCatalogPath,
  profilesRoot,
} from '@orca-web/catalog';
import type {
  CatalogNozzleVariant,
  CatalogPreset,
  CatalogPrinterModel,
  CatalogReport,
  CatalogVendor,
  PresetCompatibility,
  ProfileCatalog,
} from '@orca-web/catalog';
import { configLookup, evaluateCondition } from './compatibility.js';
import { loadProfiles } from './load-profiles.js';
import { mergeChain, resolveInheritance } from './resolve-inherits.js';

export interface BuildCatalogOptions {
  version?: string;
  /** `resources/profiles` to walk. Defaults to {@link profilesRoot}. */
  profilesDir?: string;
  outputPath?: string;
  reportPath?: string;
  log?: (msg: string) => void;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value !== '') return [value];
  return [];
}

/** `"0.2;0.4;0.6;0.8"` → `[0.2, 0.4, 0.6, 0.8]`. */
function parseNozzleList(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return value
    .split(';')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function firstNumber(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function buildProfileCatalog(opts: BuildCatalogOptions = {}): {
  catalog: ProfileCatalog;
  outputPath: string;
  reportPath: string;
} {
  const version = opts.version ?? ORCA_VERSION;
  const log = opts.log ?? (() => {});
  const root = opts.profilesDir ?? profilesRoot(version);

  const profiles = loadProfiles(root);
  const resolution = resolveInheritance(profiles);
  log(
    `profiles: ${profiles.presets.size} presets in ${profiles.vendors.size} vendors, ` +
      `${resolution.unresolved.length} unresolved`,
  );

  const ownOf = (id: string): Record<string, unknown> | undefined => profiles.presets.get(id)?.own;
  /** Fully resolved config per preset id, computed once here and reused throughout. */
  const resolved = new Map<string, Record<string, unknown>>();
  for (const [id, chain] of resolution.chains) resolved.set(id, mergeChain(chain, ownOf));

  // -------------------------------------------------------------------------
  // presets
  // -------------------------------------------------------------------------
  const presets: Record<string, CatalogPreset> = {};
  for (const preset of profiles.presets.values()) {
    const chain = resolution.chains.get(preset.id);
    if (!chain) continue; // unresolved: reported, and deliberately not catalogued
    presets[preset.id] = {
      id: preset.id,
      name: preset.name,
      type: preset.type,
      vendor: preset.vendor,
      file: preset.file,
      parent: resolution.parents.get(preset.id) ?? null,
      chain,
      instantiable: preset.instantiable,
      own: preset.own,
    };
  }

  // -------------------------------------------------------------------------
  // printer models and their nozzle variants
  // -------------------------------------------------------------------------
  const machinesByModel = new Map<string, string[]>();
  for (const preset of profiles.presets.values()) {
    if (preset.type !== 'machine') continue;
    const config = resolved.get(preset.id);
    if (!config) continue;
    const model = config.printer_model;
    if (typeof model !== 'string' || model === '') continue;
    const key = `${preset.vendor}/${model}`;
    const list = machinesByModel.get(key) ?? [];
    list.push(preset.id);
    machinesByModel.set(key, list);
  }

  const printerModels: Record<string, CatalogPrinterModel> = {};
  let nozzleVariantCount = 0;
  for (const [key, model] of profiles.machineModels) {
    const machineIds = machinesByModel.get(key) ?? [];
    const variants: CatalogNozzleVariant[] = [];
    for (const id of machineIds) {
      const preset = profiles.presets.get(id);
      const config = resolved.get(id);
      if (!preset || !config) continue;
      // Only instantiable machine presets are selectable; abstract bases are not
      // nozzle variants even though they carry a printer_model.
      if (!preset.instantiable) continue;
      const diameter = firstNumber(config.nozzle_diameter);
      variants.push({
        variant:
          typeof config.printer_variant === 'string' && config.printer_variant !== ''
            ? config.printer_variant
            : diameter !== null
              ? String(diameter)
              : '',
        nozzleDiameter: diameter ?? Number.NaN,
        machinePresetId: id,
        machinePresetName: preset.name,
      });
    }
    variants.sort(
      (a, b) => a.nozzleDiameter - b.nozzleDiameter || a.variant.localeCompare(b.variant),
    );
    nozzleVariantCount += variants.length;

    const entry: CatalogPrinterModel = {
      id: key,
      name: model.name,
      vendor: model.vendor,
      advertisedNozzleDiameters: parseNozzleList(model.raw.nozzle_diameter),
      nozzleVariants: variants,
      defaultMaterials:
        typeof model.raw.default_materials === 'string'
          ? model.raw.default_materials
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      file: model.file,
    };
    if (typeof model.raw.family === 'string') entry.family = model.raw.family;
    if (typeof model.raw.machine_tech === 'string') entry.tech = model.raw.machine_tech;
    if (typeof model.raw.model_id === 'string') entry.modelId = model.raw.model_id;
    printerModels[key] = entry;
  }

  // -------------------------------------------------------------------------
  // compatibility
  // -------------------------------------------------------------------------
  const machinesByVendor = new Map<string, string[]>();
  const allMachineIds: string[] = [];
  for (const preset of profiles.presets.values()) {
    if (preset.type !== 'machine' || !preset.instantiable) continue;
    const list = machinesByVendor.get(preset.vendor) ?? [];
    list.push(preset.id);
    machinesByVendor.set(preset.vendor, list);
    allMachineIds.push(preset.id);
  }
  // Compatibility edges are stored as indices into this array — there are ~550 000 of
  // them, and spelling out the preset ids costs 26 MB of artefact for no information.
  const machineIndexOf = new Map(allMachineIds.map((id, i) => [id, i]));

  const compatibility: Record<string, PresetCompatibility> = {};
  const unevaluated = new Map<string, number>();
  for (const preset of profiles.presets.values()) {
    if (preset.type === 'machine') continue;
    const config = resolved.get(preset.id);
    if (!config) continue;

    const printers = asStringArray(config.compatible_printers);
    const condition =
      typeof config.compatible_printers_condition === 'string' &&
      config.compatible_printers_condition.trim() !== ''
        ? config.compatible_printers_condition.trim()
        : null;
    const prints = asStringArray(config.compatible_prints);
    const printsCondition =
      typeof config.compatible_prints_condition === 'string' &&
      config.compatible_prints_condition.trim() !== ''
        ? config.compatible_prints_condition.trim()
        : null;

    const byName = new Set(printers);
    const machines: number[] = [];
    let conditionUnevaluated = false;

    // A vendor that ships no printers of its own is a shared library (in 2.4.2 that is
    // exactly `OrcaFilamentLibrary`, 283 instantiable filaments): its presets are
    // offered for every printer, so they are evaluated against every vendor's machines.
    const candidates = machinesByVendor.get(preset.vendor) ?? allMachineIds;

    for (const machineId of candidates) {
      const machine = profiles.presets.get(machineId);
      const machineConfig = resolved.get(machineId);
      if (!machine || !machineConfig) continue;

      // Upstream precedence (`Preset::is_compatible_with_printer` in libslic3r): a
      // non-empty `compatible_printers` list decides on its own and the condition is
      // NOT evaluated. That is not a nicety — 14 Prusa MK3S process presets list the
      // right printer alongside a stale `nozzle_diameter[0]==0.4` condition, and
      // AND-ing the two would hide every one of them from the 0.25/0.6/0.8 nozzles.
      if (byName.size > 0) {
        if (!byName.has(machine.name)) continue;
      } else if (condition) {
        const result = evaluateCondition(condition, configLookup(machineConfig));
        if (!result.evaluated) {
          conditionUnevaluated = true;
          unevaluated.set(condition, (unevaluated.get(condition) ?? 0) + 1);
        }
        if (!result.value) continue;
      }
      const index = machineIndexOf.get(machineId);
      if (index !== undefined) machines.push(index);
    }

    compatibility[preset.id] = {
      printers,
      condition,
      prints,
      printsCondition,
      machines,
      conditionUnevaluated,
    };
  }

  // -------------------------------------------------------------------------
  // vendors
  // -------------------------------------------------------------------------
  const vendors: Record<string, CatalogVendor> = {};
  for (const [id, vendor] of profiles.vendors) {
    const counts = { machine: 0, process: 0, filament: 0 };
    for (const preset of profiles.presets.values()) {
      if (preset.vendor === id) counts[preset.type]++;
    }
    const entry: CatalogVendor = {
      id,
      name: vendor.name,
      printerModels: Object.keys(printerModels)
        .filter((key) => printerModels[key]?.vendor === id)
        .sort(),
      counts,
    };
    if (vendor.version) entry.version = vendor.version;
    vendors[id] = entry;
  }

  // -------------------------------------------------------------------------
  // report
  // -------------------------------------------------------------------------
  const typeCounts = { machine: 0, process: 0, filament: 0 };
  let instantiable = 0;
  let withInherits = 0;
  for (const preset of profiles.presets.values()) {
    typeCounts[preset.type]++;
    if (preset.instantiable) instantiable++;
    if (preset.inherits !== null) withInherits++;
  }
  let maxChainDepth = 0;
  for (const chain of resolution.chains.values())
    maxChainDepth = Math.max(maxChainDepth, chain.length);

  const report: CatalogReport = {
    orcaVersion: version,
    generatedAt: new Date().toISOString(),
    profilesRoot: root,
    counts: {
      vendors: profiles.vendors.size,
      printerModels: Object.keys(printerModels).length,
      nozzleVariants: nozzleVariantCount,
      presets: profiles.presets.size,
      ...typeCounts,
      instantiable,
      withInherits,
      resolved: resolution.chains.size,
      maxChainDepth,
    },
    unresolved: resolution.unresolved,
    structuralProblems: profiles.problems,
    unevaluatedConditions: [...unevaluated].map(([expression, presetCount]) => ({
      expression,
      presetCount,
    })),
    presetsWithNoCompatiblePrinter: Object.entries(compatibility)
      .filter(([id, c]) => c.machines.length === 0 && presets[id]?.instantiable === true)
      .map(([id, c]) => ({ id, condition: c.condition, printers: c.printers })),
  };

  const catalog: ProfileCatalog = {
    orcaVersion: version,
    generatedAt: report.generatedAt,
    profilesRoot: root,
    vendors,
    printerModels,
    presets,
    machinePresetIds: allMachineIds,
    compatibility,
    report,
  };

  const outputPath = opts.outputPath ?? profileCatalogPath(version);
  const reportPath = opts.reportPath ?? catalogReportPath(version);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(catalog));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `profile-catalog: ${report.counts.vendors} vendors, ${report.counts.printerModels} printer models, ` +
      `${report.counts.nozzleVariants} nozzle variants, ${report.counts.presets} presets ` +
      `(${report.counts.resolved} resolved, ${resolution.unresolved.length} unresolved) -> ${outputPath}`,
  );
  return { catalog, outputPath, reportPath };
}
