/**
 * Hard constraint #5, enforced instead of merely intended.
 *
 * > Full-width touch targets, no hover-dependent affordances.
 *
 * A thumb cannot hover. A `hover:` style is therefore invisible on the primary target
 * platform, and anything that only *appears* on hover is unreachable there. The rule is
 * easy to state and easy to break by habit — `hover:bg-…` is muscle memory — so it is a
 * test rather than a code-review convention.
 *
 * If a genuinely desktop-only enhancement ever needs one, it belongs behind
 * `@media (hover: hover)`, which this check deliberately does not allow either: adding
 * it should be a conscious edit to this file with a reason attached.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `web` project is rooted at `apps/web`, but vitest is invoked from the repo root,
 * so the process cwd can be either. Both are tried rather than guessed at.
 */
const SOURCE_ROOT =
  [join(process.cwd(), 'src'), join(process.cwd(), 'apps', 'web', 'src')].find((candidate) =>
    existsSync(candidate),
  ) ?? join(process.cwd(), 'src');
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!EXTENSIONS.has(extname(path))) return [];
    // This file quotes the very patterns it forbids.
    if (path.endsWith('no-hover.test.ts')) return [];
    return [path];
  });
}

describe('touch-only affordances', () => {
  it('uses no hover styles anywhere in the client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/\bhover:|:hover\b|@media\s*\(\s*hover/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every interactive class list a touch-sized minimum', () => {
    // `tap` is the utility that sets min-height/min-width to 48px (index.css). Every
    // <button> and every <a> the client renders must carry it; the Chromium pass then
    // measures the result for real at 390px.
    const offenders: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      if (!file.endsWith('.tsx') || file.endsWith('.test.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      // Match an opening <button …> or <a …> tag, including multi-line ones.
      for (const match of source.matchAll(/<(button|a)\b[^>]*>/gs)) {
        const tag = match[0];
        if (!tag.includes('className')) continue;
        if (!/\btap\b/.test(tag)) {
          offenders.push(`${file}: ${tag.slice(0, 80).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
