/**
 * What the touch plater (M4) needs from the server, and nothing else.
 *
 *   GET  /models/:id/file        the raw model bytes, so the browser can draw the mesh
 *   GET  /plater/bed             the real build plate for a printer + nozzle
 *   POST /plater/arrange         lay the plate out with the engine's own packer
 *   POST /jobs/:id/thumbnail     put the client-rendered plate preview into the archive
 *
 * A separate module rather than four more handlers in `server.ts`: these four are one
 * feature, they share one set of validation helpers, and `server.ts` registers them in a
 * single line.
 *
 * The orchestration is deliberately *not* here. Arranging stages models into a sandbox,
 * resolves profiles and calls the engine; the thumbnail rewrite reaches into a published
 * artefact. Both are `JobService` methods, so these handlers only parse and validate.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ArrangeRequestBody,
  ArrangeResponse,
  BedSpec,
  ModelRef,
  ModelTransform,
  Point2,
  PresetRef,
} from '@orca-web/shared';
import type { CatalogService } from '../../catalog/service.js';
import type { AppConfig } from '../../config.js';
import { BadRequestError, NotFoundError, type JobService } from '../../jobs/job-service.js';
import { CatalogUnavailableError } from '../../catalog/service.js';
import type { ModelStore } from '../../storage/model-store.js';

export interface PlaterRouteDeps {
  config: AppConfig;
  service: JobService;
  models: ModelStore;
  catalog: CatalogService | undefined;
}

const MODEL_CONTENT_TYPES: Record<string, string> = {
  '.stl': 'model/stl',
  '.3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  '.obj': 'model/obj',
  '.amf': 'application/octet-stream',
  '.step': 'application/step',
  '.stp': 'application/step',
};

/**
 * `"256x256"` → `[256, 256]`.
 *
 * libslic3r stores `printable_area` and `bed_exclude_area` as a vector of `XxY` strings,
 * not as numbers. Anything unparseable is dropped rather than turned into a NaN that
 * would silently draw a bed at the origin.
 */
export function parsePoints(value: unknown): Point2[] {
  if (!Array.isArray(value)) return [];
  const points: Point2[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const match = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)\s*$/i.exec(entry);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

function firstNumber(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

export function bedSpecFrom(
  config: Record<string, unknown>,
  preset: PresetRef,
): Omit<BedSpec, 'preset'> & { preset: PresetRef } {
  const printableArea = parsePoints(config.printable_area);
  return {
    printerModel: typeof config.printer_model === 'string' ? config.printer_model : null,
    preset,
    // A machine preset with no printable_area has not been flattened (deviation #1);
    // falling back to a plausible square would hide exactly the bug that matters.
    printableArea,
    printableHeight: firstNumber(config.printable_height, 0),
    excludeArea: parsePoints(config.bed_exclude_area),
    extruderOffset: parsePoints(config.extruder_offset)[0] ?? [0, 0],
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`"${field}" is required`);
  }
  return value;
}

function assertPresetRef(value: unknown, field: string): PresetRef {
  const ref = value as PresetRef | undefined;
  if (!ref || typeof ref !== 'object') throw new BadRequestError(`"${field}" is required`);
  requireString(ref.name, `${field}.name`);
  requireString(ref.vendor, `${field}.vendor`);
  return ref;
}

function assertModelRef(value: unknown, field: string): ModelRef {
  const ref = value as ModelRef | undefined;
  if (!ref || typeof ref !== 'object') throw new BadRequestError(`"${field}" is required`);
  if (ref.source === 'library' && typeof ref.id === 'string') return ref;
  if (ref.source === 'upload' && typeof ref.filename === 'string') {
    throw new BadRequestError(
      `"${field}" must reference a stored model`,
      'Upload it with POST /models first; arranging does not accept file parts.',
    );
  }
  throw new BadRequestError(`"${field}" must be {source:"library", id}`);
}

function assertTransform(value: unknown, field: string): ModelTransform | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 9 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    throw new BadRequestError(`"${field}" must be nine finite numbers (a row-major 3x3 matrix)`);
  }
  return value as ModelTransform;
}

export function registerPlaterRoutes(app: FastifyInstance, deps: PlaterRouteDeps): void {
  const requireCatalog = (): CatalogService => {
    if (!deps.catalog) {
      throw new CatalogUnavailableError('the generated profile catalog was not loaded at start-up');
    }
    return deps.catalog;
  };

  // The plate preview arrives as raw PNG bytes rather than multipart: it is one file, it
  // is generated, and a multipart envelope around it would only add parsing.
  app.addContentTypeParser(
    'image/png',
    { parseAs: 'buffer', bodyLimit: deps.config.maxThumbnailBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /**
   * The model bytes, for the plater's mesh loader.
   *
   * Content-addressed and immutable, so it is cached hard and forever: the id *is* the
   * hash, and a different model is a different URL.
   */
  app.get('/models/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = deps.models.get(id);
    if (!model) throw new NotFoundError(`model ${id} is not in the library`);
    let path: string;
    try {
      path = deps.models.pathFor(model.id);
      await stat(path);
    } catch {
      throw new NotFoundError(`model ${id} is no longer available`);
    }
    deps.models.touch(model.id);
    return reply
      .header(
        'Content-Type',
        MODEL_CONTENT_TYPES[extname(model.filename).toLowerCase()] ?? 'application/octet-stream',
      )
      .header('Content-Length', String(model.bytes))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(createReadStream(path));
  });

  /** The real build plate for a printer + nozzle. Never a hardcoded 256×256. */
  app.get('/plater/bed', async (request): Promise<BedSpec> => {
    const query = request.query as { model?: string; vendor?: string; nozzle?: string };
    const model = requireString(query.model, 'model');
    const catalog = requireCatalog();
    const preset = catalog.query.machinePresetFor({
      model,
      ...(query.vendor === undefined ? {} : { vendor: query.vendor }),
      ...(query.nozzle === undefined ? {} : { nozzle: query.nozzle }),
    });
    if (!preset) {
      throw new NotFoundError(
        `no machine preset for "${model}"${query.nozzle === undefined ? '' : ` with a ${query.nozzle} nozzle`}`,
      );
    }
    return bedSpecFrom(preset.config, {
      kind: 'machine',
      vendor: preset.vendor,
      name: preset.name,
    });
  });

  /**
   * Auto-arrange. SPEC: this delegates to the engine (`--arrange 1`) — we do not write a
   * bin packer, because the engine is the only thing that knows the bed's exclusion zones
   * and its own clearances.
   */
  app.post('/plater/arrange', async (request): Promise<ArrangeResponse> => {
    const body = request.body as ArrangeRequestBody | undefined;
    if (!body || typeof body !== 'object') throw new BadRequestError('a JSON body is required');
    if (!Array.isArray(body.objects)) throw new BadRequestError('"objects" must be an array');

    const placements = await deps.service.arrangePlate({
      printer: assertPresetRef(body.printer, 'printer'),
      process: assertPresetRef(body.process, 'process'),
      objects: body.objects.map((object, index) => {
        const transform = assertTransform(object?.transform, `objects[${index}].transform`);
        const model = assertModelRef(object?.model, `objects[${index}].model`);
        return transform === undefined ? { model } : { model, transform };
      }),
    });

    return {
      instances: placements.map((placement) => ({
        position: placement.position,
        rotation: placement.rotation,
      })),
    };
  });

  /**
   * The thumbnail rewrite (SPEC: "the blank thumbnail is our problem to solve").
   *
   * The preview is rendered from the WebGL view on the client — there is no display
   * server here and the slicer needs OpenGL for it — and written into the served
   * `.gcode.3mf`. VERIFIED DEVIATION #5: with `--min-save` the member is *absent*, not
   * blank, so this adds one.
   */
  app.post('/jobs/:id/thumbnail', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { plate?: string };
    const plate = query.plate === undefined ? 1 : Number.parseInt(query.plate, 10);
    if (!Number.isInteger(plate) || plate < 1) {
      throw new BadRequestError('"plate" must be a positive plate number');
    }
    const png = request.body;
    if (!Buffer.isBuffer(png) || png.byteLength === 0) {
      throw new BadRequestError(
        'the request body must be a PNG',
        'Send it as image/png with no multipart envelope.',
      );
    }
    const bytes = await deps.service.attachPlateThumbnail(id, plate, png);
    return reply.status(200).send({ plate, bytes });
  });
}
