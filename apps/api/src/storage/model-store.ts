/**
 * The content-addressed model library.
 *
 * Settled decision: uploaded models PERSIST so a model can be re-sliced at different
 * settings without re-uploading — on a phone that is the difference between a usable
 * product and an unusable one. Deduplication falls out of content addressing for free:
 * the same STL uploaded twice is stored once.
 *
 * This is separate from, and must not weaken, the ephemerality of `/work`. Sandboxes
 * are deleted after every job (sandbox.ts); library blobs outlive jobs and are bounded
 * by a quota plus an LRU/TTL sweeper instead.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ModelSummary } from '@orca-web/shared';
import type { Db } from './db.js';

export interface ModelStoreConfig {
  /** Blobs live under `<dataDir>/models/<first two hex chars>/<hex>`. */
  dataDir: string;
  maxBytes: number;
  ttlMs: number;
}

export interface SweepResult {
  evicted: number;
  bytesFreed: number;
  totalBytes: number;
}

interface ModelRow {
  id: string;
  filename: string;
  bytes: number;
  created_at: number;
  last_used_at: number;
}

export class QuotaExceededError extends Error {
  constructor(needed: number, limit: number) {
    super(`model would need ${needed} bytes but the library limit is ${limit}`);
    this.name = 'QuotaExceededError';
  }
}

function toSummary(row: ModelRow): ModelSummary {
  return {
    id: row.id,
    filename: row.filename,
    bytes: row.bytes,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
  };
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return `sha256:${hash.digest('hex')}`;
}

export class ModelStore {
  private readonly db: Db;
  private readonly config: ModelStoreConfig;
  private readonly root: string;

  constructor(db: Db, config: ModelStoreConfig) {
    this.db = db;
    this.config = config;
    this.root = join(config.dataDir, 'models');
  }

  /** Path a blob has (or would have). Content-addressed, so it never collides. */
  pathFor(id: string): string {
    const hex = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a model id: ${id}`);
    return join(this.root, hex.slice(0, 2), hex);
  }

  get(id: string): ModelSummary | undefined {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as
      ModelRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  list(limit = 100): ModelSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM models ORDER BY last_used_at DESC LIMIT ?')
      .all(limit) as unknown as ModelRow[];
    return rows.map(toSummary);
  }

  totalBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM models').get() as {
      total: number;
    };
    return Number(row.total);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE models SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Store bytes already on disk. The source is copied, never moved: it may be shared. */
  async putFile(source: string, filename: string): Promise<ModelSummary> {
    const id = await hashFile(source);
    const bytes = (await stat(source)).size;
    return this.commit(id, filename, bytes, async (destination) => {
      await copyFile(source, `${destination}.tmp`);
      await rename(`${destination}.tmp`, destination);
    });
  }

  async putBuffer(data: Uint8Array, filename: string): Promise<ModelSummary> {
    const id = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    return this.commit(id, filename, data.byteLength, async (destination) => {
      await writeFile(`${destination}.tmp`, data);
      await rename(`${destination}.tmp`, destination);
    });
  }

  private async commit(
    id: string,
    filename: string,
    bytes: number,
    write: (destination: string) => Promise<void>,
  ): Promise<ModelSummary> {
    if (bytes > this.config.maxBytes) throw new QuotaExceededError(bytes, this.config.maxBytes);

    const now = Date.now();
    const existing = this.get(id);
    if (existing) {
      // Same content: keep one blob, refresh the LRU stamp, and remember the newest
      // name the user gave it.
      this.db
        .prepare('UPDATE models SET last_used_at = ?, filename = ? WHERE id = ?')
        .run(now, filename, id);
      return { ...existing, filename, lastUsedAt: new Date(now).toISOString() };
    }

    const destination = this.pathFor(id);
    await mkdir(join(destination, '..'), { recursive: true });
    await write(destination);
    this.db
      .prepare(
        'INSERT INTO models (id, filename, bytes, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, filename, bytes, now, now);

    return {
      id,
      filename,
      bytes,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
    };
  }

  /**
   * TTL first, then LRU down to the quota.
   *
   * `protectedIds` are models referenced by jobs that have not finished — evicting one
   * of those would break a slice that is queued or running.
   */
  async sweep(protectedIds: ReadonlySet<string> = new Set()): Promise<SweepResult> {
    const now = Date.now();
    const rows = this.db
      .prepare('SELECT * FROM models ORDER BY last_used_at ASC')
      .all() as unknown as ModelRow[];

    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    let evicted = 0;
    let bytesFreed = 0;

    for (const row of rows) {
      const expired = now - row.last_used_at > this.config.ttlMs;
      const overQuota = total > this.config.maxBytes;
      if (!expired && !overQuota) break; // rows are LRU-ordered; nothing older remains
      if (protectedIds.has(row.id)) continue;

      await rm(this.pathFor(row.id), { force: true });
      this.db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
      total -= row.bytes;
      bytesFreed += row.bytes;
      evicted += 1;
    }

    return { evicted, bytesFreed, totalBytes: total };
  }
}
