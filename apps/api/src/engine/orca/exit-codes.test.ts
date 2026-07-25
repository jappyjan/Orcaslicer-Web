import { describe, expect, it } from 'vitest';
import {
  ORCA_EXIT_CODES,
  describeExitCode,
  sliceErrorForExit,
  toSignedExitCode,
} from './exit-codes.js';

describe('exit codes', () => {
  // MEASURED against the pinned 2.4.2 binary in the container:
  //   missing input file        -> shell status 253  (CLI_FILE_NOTFOUND        = -3)
  //   malformed preset JSON     -> shell status 251  (CLI_CONFIG_FILE_ERROR    = -5)
  //   --outputdir + abs export  -> shell status 243  (CLI_EXPORT_3MF_ERROR     = -13)
  it.each([
    [253, -3, 'CLI_FILE_NOTFOUND'],
    [251, -5, 'CLI_CONFIG_FILE_ERROR'],
    [243, -13, 'CLI_EXPORT_3MF_ERROR'],
  ])('undoes the 8-bit truncation of exit status %i', (status, signed, symbol) => {
    expect(toSignedExitCode(status)).toBe(signed);
    expect(describeExitCode(status)?.symbol).toBe(symbol);
  });

  it('leaves ordinary small statuses alone', () => {
    expect(toSignedExitCode(0)).toBe(0);
    expect(toSignedExitCode(1)).toBe(1);
  });

  it('maps every upstream code to a typed error with a user-readable message', () => {
    for (const [value, entry] of ORCA_EXIT_CODES) {
      expect(entry.symbol).toMatch(/^CLI_/);
      expect(entry.message.length).toBeGreaterThan(10);
      // A user must never be shown an exit code or an upstream symbol.
      expect(entry.message).not.toMatch(/CLI_|exit|return -/i);
      expect(value).toBeLessThan(0);
    }
  });

  it('never surfaces the raw exit code or stderr in the client-facing error', () => {
    const error = sliceErrorForExit(243, 'return -13\nsome/internal/path.cpp:123');
    const api = error.toApiError();
    expect(api.code).toBe('EXPORT_FAILED');
    expect(JSON.stringify(api)).not.toContain('-13');
    expect(JSON.stringify(api)).not.toContain('path.cpp');
    // ...but the detail is kept for the server log.
    expect(error.detail).toContain('CLI_EXPORT_3MF_ERROR');
    expect(error.detail).toContain('path.cpp');
  });

  it('falls back to a typed crash for a status not in the table', () => {
    const error = sliceErrorForExit(139, 'segfault');
    expect(error.code).toBe('ENGINE_CRASHED');
    expect(error.retryable).toBe(true);
  });
});
