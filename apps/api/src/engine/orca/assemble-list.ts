/**
 * `--load-assemble-list`: build a plate without authoring a 3MF.
 *
 * This is the preferred input path (SPEC): the client sends geometry references plus
 * transforms, we write this JSON, and nothing has to author a 3MF in a phone browser.
 *
 * Field semantics that are easy to get wrong, per SPEC and confirmed against 2.4.2:
 *  - `filaments` holds 1-based slot indices; its length must be 1 (applies to every
 *    copy) or exactly `count`. The same rule applies to `assemble_index` and the
 *    position arrays.
 *  - objects sharing an `assemble_index` are merged into ONE composed model — that is
 *    how a multi-part object is built from separate STLs.
 *  - `pos_x` / `pos_y` are ONLY honoured when `need_arrange` is false. We therefore
 *    refuse to emit positions alongside `need_arrange: true` rather than emit numbers
 *    the engine will quietly ignore.
 */

import type { EngineObject, EnginePlate } from '../port.js';

export interface AssembleListObject {
  path: string;
  count: number;
  filaments: number[];
  assemble_index: number[];
  pos_x?: number[];
  pos_y?: number[];
  pos_z?: number[];
  subtype: string;
  print_params: Record<string, string | number | boolean>;
  height_ranges: Array<Record<string, unknown>>;
}

export interface AssembleListPlate {
  plate_index: number;
  plate_name: string;
  need_arrange: boolean;
  plate_params: Record<string, unknown>;
  objects: AssembleListObject[];
}

export interface AssembleList {
  plates: AssembleListPlate[];
}

export class AssembleListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssembleListError';
  }
}

function fanOut(name: string, values: number[] | undefined, count: number, fallback: number[]) {
  if (values === undefined || values.length === 0) return fallback;
  if (values.length !== 1 && values.length !== count) {
    throw new AssembleListError(
      `${name} must have exactly 1 or ${count} entries (got ${values.length})`,
    );
  }
  return values;
}

function buildObject(object: EngineObject, arrange: boolean): AssembleListObject {
  const count = object.count;
  if (!Number.isInteger(count) || count < 1) {
    throw new AssembleListError(`object count must be a positive integer (got ${String(count)})`);
  }

  const positioned =
    object.posX !== undefined || object.posY !== undefined || object.posZ !== undefined;
  if (arrange && positioned) {
    throw new AssembleListError(
      'positions were supplied for an auto-arranged plate; pos_x/pos_y are only honoured when need_arrange is false',
    );
  }

  const out: AssembleListObject = {
    path: object.path,
    count,
    filaments: fanOut('filaments', object.filaments, count, [1]),
    assemble_index: fanOut('assemble_index', object.assembleIndex, count, [1]),
    subtype: object.subtype,
    print_params: object.printParams,
    height_ranges: object.heightRanges.map((range) => ({
      min_z: range.minZ,
      max_z: range.maxZ,
      range_params: range.rangeParams,
    })),
  };

  if (!arrange && positioned) {
    out.pos_x = fanOut('pos_x', object.posX, count, [0]);
    out.pos_y = fanOut('pos_y', object.posY, count, [0]);
    out.pos_z = fanOut('pos_z', object.posZ, count, [0]);
  }

  return out;
}

export function buildAssembleList(plates: readonly EnginePlate[]): AssembleList {
  if (plates.length === 0) throw new AssembleListError('a job must contain at least one plate');
  return {
    plates: plates.map((plate) => {
      if (plate.objects.length === 0) {
        throw new AssembleListError(`plate ${plate.index} has no objects`);
      }
      return {
        plate_index: plate.index,
        plate_name: plate.name,
        need_arrange: plate.arrange,
        plate_params: {},
        objects: plate.objects.map((object) => buildObject(object, plate.arrange)),
      };
    }),
  };
}
