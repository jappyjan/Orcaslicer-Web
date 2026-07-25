import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { ModelStore, QuotaExceededError } from './model-store.js';

let dataDir = '';
let store: ModelStore;
let db: ReturnType<typeof openDatabase>;

function makeStore(overrides: { maxBytes?: number; ttlMs?: number } = {}): ModelStore {
  return new ModelStore(db, {
    dataDir,
    maxBytes: overrides.maxBytes ?? 1024 * 1024,
    ttlMs: overrides.ttlMs ?? 60_000,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'model-store-'));
  db = openDatabase(join(dataDir, 'test.db'));
  store = makeStore();
});
afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function file(name: string, contents: string): Promise<string> {
  const path = join(dataDir, name);
  await writeFile(path, contents);
  return path;
}

describe('ModelStore', () => {
  it('stores a model under its content hash', async () => {
    const model = await store.putFile(await file('cube.stl', 'solid cube'), 'cube.stl');
    expect(model.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(model.bytes).toBe('solid cube'.length);
    expect((await stat(store.pathFor(model.id))).size).toBe(model.bytes);
  });

  // The point of content addressing: a re-slice needs no re-upload, and an upload of
  // something already stored costs one row update.
  it('deduplicates identical content', async () => {
    const first = await store.putFile(await file('a.stl', 'same bytes'), 'a.stl');
    const second = await store.putFile(await file('b.stl', 'same bytes'), 'renamed.stl');
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    // The newest name wins, so the UI shows what the user last called it.
    expect(store.get(first.id)?.filename).toBe('renamed.stl');
  });

  it('rejects a single model larger than the whole quota', async () => {
    const small = makeStore({ maxBytes: 4 });
    await expect(
      small.putFile(await file('big.stl', 'more than four bytes'), 'big.stl'),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('evicts least-recently-used models to get back under quota', async () => {
    const tight = makeStore({ maxBytes: 30 });
    const oldest = await tight.putFile(await file('1.stl', 'a'.repeat(20)), '1.stl');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = await tight.putFile(await file('2.stl', 'b'.repeat(20)), '2.stl');

    const result = await tight.sweep();
    expect(result.evicted).toBe(1);
    expect(tight.get(oldest.id)).toBeUndefined();
    expect(tight.get(newest.id)).toBeDefined();
    // The blob is gone from disk, not just from the index.
    await expect(stat(tight.pathFor(oldest.id))).rejects.toThrow();
  });

  it('evicts by TTL even when under quota', async () => {
    const expiring = makeStore({ ttlMs: 1 });
    const model = await expiring.putFile(await file('old.stl', 'x'), 'old.stl');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await expiring.sweep()).evicted).toBe(1);
    expect(expiring.get(model.id)).toBeUndefined();
  });

  it('never evicts a model a queued or running job still needs', async () => {
    const tight = makeStore({ maxBytes: 30, ttlMs: 1 });
    const model = await tight.putFile(await file('busy.stl', 'y'.repeat(20)), 'busy.stl');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await tight.sweep(new Set([model.id]))).evicted).toBe(0);
    expect(tight.get(model.id)).toBeDefined();
  });

  it('refreshes the LRU stamp when a model is reused', async () => {
    const model = await store.putFile(await file('reused.stl', 'z'), 'reused.stl');
    const before = store.get(model.id)?.lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.touch(model.id);
    expect(store.get(model.id)?.lastUsedAt).not.toBe(before);
  });

  it('rejects an id that is not a content hash', () => {
    expect(() => store.pathFor('../../etc/passwd')).toThrow(/not a model id/);
  });

  it('leaves no partial files behind', async () => {
    await store.putFile(await file('c.stl', 'contents'), 'c.stl');
    const shards = await readdir(join(dataDir, 'models'));
    for (const shard of shards) {
      const names = await readdir(join(dataDir, 'models', shard));
      expect(names.every((name) => !name.endsWith('.tmp'))).toBe(true);
    }
  });
});
