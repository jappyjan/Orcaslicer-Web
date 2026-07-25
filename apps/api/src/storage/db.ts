/**
 * SQLite metadata store. Filesystem for blobs, SQLite for everything else, no cloud
 * dependencies (settled stack decision).
 *
 * `node:sqlite` ships with Node 22, so there is no native module to compile and no
 * migration story to invent for a single-file, single-tenant deployment.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS models_last_used ON models (last_used_at);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  state       TEXT NOT NULL,
  request     TEXT NOT NULL,
  models      TEXT NOT NULL DEFAULT '[]',
  percent     REAL NOT NULL DEFAULT 0,
  message     TEXT,
  warnings    TEXT NOT NULL DEFAULT '[]',
  artifacts   TEXT NOT NULL DEFAULT '[]',
  stats       TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);

-- M6's named user presets. A set of config-key OVERRIDES, not a profile: nothing this
-- application stores is ever written into OrcaSlicer's own resources/profiles tree.
-- See settings/user-preset-store.ts for why that distinction is load-bearing.
CREATE TABLE IF NOT EXISTS user_presets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  overrides  TEXT NOT NULL DEFAULT '{}',
  based_on   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_presets_updated ON user_presets (updated_at);
`;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
