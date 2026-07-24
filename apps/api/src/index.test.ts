import { describe, expect, it } from 'vitest';
import { describeBuild } from './index.js';

describe('describeBuild', () => {
  it('reports the pinned slicer version', () => {
    expect(describeBuild()).toMatch(/^orcaslicer-web \(OrcaSlicer \d+\.\d+\.\d+\)$/);
  });
});
