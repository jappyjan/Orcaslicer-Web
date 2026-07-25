/**
 * What the generated settings UI (M6) needs from the server.
 *
 *   GET    /settings/resolved      the values a slice would use BEFORE any override
 *   GET    /settings/presets       named user presets (ours, not OrcaSlicer's)
 *   POST   /settings/presets       save one
 *   PUT    /settings/presets/:id   replace one
 *   DELETE /settings/presets/:id
 *
 * The option *definitions* are not here: they are the config schema, which already ships
 * as `GET /catalog?schema=1` and is static per OrcaSlicer version, so it is cached and
 * ETagged with the rest of the catalog rather than served twice.
 *
 * `/settings/resolved` exists because "modified from the preset" has to be measured
 * against the **preset**, not against the compiled-in `PrintConfig` default. Those two
 * are different things and confusing them is SPEC deviation #1's exact failure mode —
 * the CLI silently falls back to the default for every key a preset does not mention, so
 * a UI that diffed against the default would call a value "unmodified" when the slice was
 * about to use something else entirely. This route returns the flattened machine ⊕
 * process ⊕ filament merge with a per-key note of which preset supplied it, so the client
 * can say "this came from your preset" and "this key is not in any preset, so the slicer
 * would use its built-in default" as two different sentences.
 */

import type { FastifyInstance } from 'fastify';
import type {
  PresetRef,
  ResolvedSettings,
  SettingOverrides,
  SettingSource,
  SettingValue,
  UserPreset,
  UserPresetListResponse,
} from '@orca-web/shared';
import type { CatalogService } from '../../catalog/service.js';
import { CatalogUnavailableError } from '../../catalog/service.js';
import { BadRequestError, NotFoundError } from '../../jobs/job-service.js';
import type { ProfileResolver } from '../../profiles/port.js';
import { coerceOverrides, UnknownSettingError } from '../../settings/schema.js';
import {
  MAX_PRESET_NAME_LENGTH,
  UserPresetLimitError,
  type UserPresetStore,
} from '../../settings/user-preset-store.js';

export interface SettingsRouteDeps {
  resolver: ProfileResolver;
  catalog: CatalogService | undefined;
  userPresets: UserPresetStore;
}

/** The three presets, in the order the engine layers them. Later wins on a collision. */
const LAYERS: ReadonlyArray<{ kind: PresetRef['kind']; source: SettingSource }> = [
  { kind: 'machine', source: 'machine' },
  { kind: 'process', source: 'process' },
  { kind: 'filament', source: 'filament' },
];

function requireRef(
  query: Record<string, string | undefined>,
  prefix: string,
  kind: PresetRef['kind'],
): PresetRef {
  const vendor = query[`${prefix}Vendor`];
  const name = query[`${prefix}Name`];
  if (vendor === undefined || vendor === '' || name === undefined || name === '') {
    throw new BadRequestError(
      `"${prefix}Vendor" and "${prefix}Name" are required`,
      'e.g. /settings/resolved?machineVendor=BBL&machineName=Bambu%20Lab%20X1%20Carbon%200.4%20nozzle&…',
    );
  }
  return { kind, vendor, name };
}

/**
 * Preset values arrive as whatever the profile JSON held — usually strings, often
 * one-element arrays. They are passed through untouched: this is a *description of what
 * the slice would do*, and reinterpreting it here would make the client's "is this
 * modified?" comparison a comparison against our guess rather than against the preset.
 */
function asSettingValue(value: unknown): SettingValue {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((element) =>
      typeof element === 'string' || typeof element === 'number' || typeof element === 'boolean'
        ? element
        : String(element),
    );
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function assertPresetRefBody(value: unknown): PresetRef | undefined {
  if (value === undefined || value === null) return undefined;
  const ref = value as PresetRef;
  if (typeof ref.vendor !== 'string' || typeof ref.name !== 'string') return undefined;
  return { kind: ref.kind, vendor: ref.vendor, name: ref.name };
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const requireSchema = (): NonNullable<ReturnType<CatalogService['query']['configSchema']>> => {
    const schema = deps.catalog?.query.configSchema();
    if (!schema) {
      throw new CatalogUnavailableError('the generated config schema was not loaded at start-up');
    }
    return schema;
  };

  /**
   * The base a diff is measured against.
   *
   * Not cached with an ETag like `/catalog`: the answer depends on three preset names and
   * the merge is a handful of `Object.assign`s over already-memoised resolutions, so the
   * cache would cost more than the work.
   */
  app.get('/settings/resolved', async (request): Promise<ResolvedSettings> => {
    const query = request.query as Record<string, string | undefined>;
    const refs = {
      machine: requireRef(query, 'machine', 'machine'),
      process: requireRef(query, 'process', 'process'),
      filament: requireRef(query, 'filament', 'filament'),
    };

    const values: Record<string, SettingValue> = {};
    const sources: Record<string, SettingSource> = {};
    for (const layer of LAYERS) {
      const ref = refs[layer.source];
      const profile = await deps.resolver.resolve(ref);
      for (const [key, value] of Object.entries(profile.values)) {
        // `inherits`/`instantiation` are gone by now (flattenForSlicer strips them), but
        // a resolver adapter that did not would put a phantom "setting" in the form.
        if (key === 'inherits' || key === 'instantiation' || key === 'type' || key === 'name') {
          continue;
        }
        values[key] = asSettingValue(value);
        sources[key] = layer.source;
      }
    }

    return { values, sources, presets: refs };
  });

  // -------------------------------------------------------------------------
  // Named user presets
  // -------------------------------------------------------------------------

  app.get('/settings/presets', async (): Promise<UserPresetListResponse> => ({
    presets: deps.userPresets.list(),
  }));

  const save = (id: string | undefined, body: unknown): UserPreset => {
    if (!body || typeof body !== 'object') throw new BadRequestError('a JSON body is required');
    const input = body as { name?: unknown; overrides?: unknown; basedOn?: unknown };
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new BadRequestError(
        '"name" is required',
        `Up to ${MAX_PRESET_NAME_LENGTH} characters.`,
      );
    }
    if (!input.overrides || typeof input.overrides !== 'object' || Array.isArray(input.overrides)) {
      throw new BadRequestError('"overrides" must be an object of setting keys');
    }

    // Validated against the same schema the slice will be, so a saved preset cannot
    // become a job that 400s months later.
    let overrides: SettingOverrides;
    try {
      overrides = coerceOverrides(requireSchema(), input.overrides as Record<string, unknown>);
    } catch (error) {
      if (error instanceof UnknownSettingError) {
        throw new BadRequestError(error.message, error.hint);
      }
      throw error;
    }

    const rawBase = (input.basedOn ?? null) as Record<string, unknown> | null;
    const basedOn =
      rawBase === null
        ? null
        : {
            ...(assertPresetRefBody(rawBase.machine) === undefined
              ? {}
              : { machine: assertPresetRefBody(rawBase.machine) as PresetRef }),
            ...(assertPresetRefBody(rawBase.process) === undefined
              ? {}
              : { process: assertPresetRefBody(rawBase.process) as PresetRef }),
            ...(assertPresetRefBody(rawBase.filament) === undefined
              ? {}
              : { filament: assertPresetRefBody(rawBase.filament) as PresetRef }),
          };

    try {
      return deps.userPresets.save({
        ...(id === undefined ? {} : { id }),
        name: input.name,
        overrides,
        basedOn,
      });
    } catch (error) {
      if (error instanceof UserPresetLimitError) throw new BadRequestError(error.message);
      throw error;
    }
  };

  app.post('/settings/presets', async (request, reply) =>
    reply.status(201).send(save(undefined, request.body)),
  );

  app.put('/settings/presets/:id', async (request) =>
    save((request.params as { id: string }).id, request.body),
  );

  app.delete('/settings/presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.userPresets.delete(id)) throw new NotFoundError(`no saved setting ${id}`);
    return reply.status(204).send();
  });
}
