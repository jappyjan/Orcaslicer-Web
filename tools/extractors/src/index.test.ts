import { describe, expect, it } from 'vitest';
import { EXTRACTOR_TARGETS } from './index.js';

describe('extractors', () => {
  it('declares the two M2 extraction targets', () => {
    expect(EXTRACTOR_TARGETS).toEqual(['config-schema', 'profile-catalog']);
  });
});
