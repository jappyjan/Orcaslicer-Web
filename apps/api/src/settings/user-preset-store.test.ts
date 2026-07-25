import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/db.js';
import { MAX_USER_PRESETS, UserPresetLimitError, UserPresetStore } from './user-preset-store.js';

function store(): UserPresetStore {
  return new UserPresetStore(openDatabase(':memory:'));
}

describe('UserPresetStore', () => {
  it('saves a named set of overrides and reads it back whole', () => {
    const presets = store();
    const saved = presets.save({
      name: 'Fast draft',
      overrides: { layer_height: 0.28, enable_arc_fitting: false, nozzle_temperature: [235] },
      basedOn: { process: { kind: 'process', vendor: 'BBL', name: '0.20mm Standard @BBL X1C' } },
    });
    expect(saved.name).toBe('Fast draft');
    expect(presets.get(saved.id)?.overrides).toEqual({
      layer_height: 0.28,
      enable_arc_fitting: false,
      nozzle_temperature: [235],
    });
    expect(presets.get(saved.id)?.basedOn?.process?.name).toBe('0.20mm Standard @BBL X1C');
  });

  it('replaces by id and keeps the original creation time', () => {
    const presets = store();
    const first = presets.save({ name: 'Draft', overrides: { layer_height: 0.28 }, basedOn: null });
    const second = presets.save({
      id: first.id,
      name: 'Draft v2',
      overrides: { layer_height: 0.3 },
      basedOn: null,
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(presets.list()).toHaveLength(1);
    expect(presets.list()[0]?.overrides).toEqual({ layer_height: 0.3 });
  });

  it('lists most recently updated first', () => {
    const presets = store();
    presets.save({ name: 'A', overrides: {}, basedOn: null });
    const b = presets.save({ name: 'B', overrides: {}, basedOn: null });
    expect(presets.list()[0]?.id).toBe(b.id);
  });

  it('deletes, and reports whether there was anything to delete', () => {
    const presets = store();
    const saved = presets.save({ name: 'A', overrides: {}, basedOn: null });
    expect(presets.delete(saved.id)).toBe(true);
    expect(presets.delete(saved.id)).toBe(false);
    expect(presets.list()).toEqual([]);
  });

  it('needs a name', () => {
    expect(() => store().save({ name: '   ', overrides: {}, basedOn: null })).toThrow(
      UserPresetLimitError,
    );
  });

  it('bounds how many one server keeps', () => {
    const presets = store();
    for (let i = 0; i < MAX_USER_PRESETS; i += 1) {
      presets.save({ name: `preset ${i}`, overrides: {}, basedOn: null });
    }
    expect(() => presets.save({ name: 'one too many', overrides: {}, basedOn: null })).toThrow(
      UserPresetLimitError,
    );
    // Replacing an existing one is still fine at the limit.
    const existing = presets.list()[0] as { id: string };
    expect(
      presets.save({ id: existing.id, name: 'renamed', overrides: {}, basedOn: null }).name,
    ).toBe('renamed');
  });
});
