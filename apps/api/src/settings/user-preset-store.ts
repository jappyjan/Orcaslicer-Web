/**
 * Named user presets — **ours**, stored on our side.
 *
 * A user preset is a *diff*: a set of overrides plus the catalog presets it was captured
 * against. It is never a profile file, and specifically never a file in OrcaSlicer's
 * `resources/profiles` tree. Two reasons, both hard:
 *
 *  - Hard constraint #1 keeps the pinned install unmodified so an upgrade stays a version
 *    bump. Writing into its profile tree would make every upgrade a merge.
 *  - SPEC deviation #1: a preset file the CLI reads applies only the keys literally in it
 *    and silently defaults everything else. A hand-written "user profile" is therefore
 *    the single most dangerous artefact this application could produce — it would slice
 *    plausibly and wrongly at exit 0. Overrides are flags, and a flag changes one key and
 *    nothing else.
 *
 * The same SQLite file as jobs and models: filesystem for blobs, SQLite for metadata, no
 * cloud dependencies (settled stack decision).
 */

import { randomUUID } from 'node:crypto';
import type { SettingOverrides, UserPreset } from '@orca-web/shared';
import type { Db } from '../storage/db.js';

interface Row {
  id: string;
  name: string;
  overrides: string;
  based_on: string | null;
  created_at: number;
  updated_at: number;
}

/** A ceiling, so a runaway client cannot fill the database. Not a product limit. */
export const MAX_USER_PRESETS = 200;
export const MAX_PRESET_NAME_LENGTH = 80;

export class UserPresetLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserPresetLimitError';
  }
}

export class UserPresetStore {
  constructor(private readonly db: Db) {}

  list(): UserPreset[] {
    const rows = this.db
      .prepare('SELECT * FROM user_presets ORDER BY updated_at DESC')
      .all() as unknown as Row[];
    return rows.map(toPreset);
  }

  get(id: string): UserPreset | null {
    const row = this.db.prepare('SELECT * FROM user_presets WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row === undefined ? null : toPreset(row);
  }

  /**
   * Create or replace. `id` absent means create; an unknown `id` is a create too, so a
   * client that kept a preset across a database reset does not have to special-case it.
   */
  save(input: {
    id?: string;
    name: string;
    overrides: SettingOverrides;
    basedOn: UserPreset['basedOn'];
  }): UserPreset {
    const name = input.name.trim().slice(0, MAX_PRESET_NAME_LENGTH);
    if (name === '') throw new UserPresetLimitError('a preset needs a name');

    const existing = input.id === undefined ? null : this.get(input.id);
    if (existing === null) {
      const count = (
        this.db.prepare('SELECT COUNT(*) AS n FROM user_presets').get() as { n: number }
      ).n;
      if (count >= MAX_USER_PRESETS) {
        throw new UserPresetLimitError(
          `this server keeps at most ${MAX_USER_PRESETS} saved settings`,
        );
      }
    }

    const now = Date.now();
    const id = existing?.id ?? input.id ?? randomUUID();
    const createdAt = existing === null ? now : Date.parse(existing.createdAt);
    this.db
      .prepare(
        `INSERT INTO user_presets (id, name, overrides, based_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           overrides = excluded.overrides,
           based_on = excluded.based_on,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        name,
        JSON.stringify(input.overrides),
        input.basedOn === null ? null : JSON.stringify(input.basedOn),
        createdAt,
        now,
      );
    return this.get(id) as UserPreset;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM user_presets WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}

function toPreset(row: Row): UserPreset {
  return {
    id: row.id,
    name: row.name,
    overrides: JSON.parse(row.overrides) as SettingOverrides,
    basedOn: row.based_on === null ? null : (JSON.parse(row.based_on) as UserPreset['basedOn']),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
