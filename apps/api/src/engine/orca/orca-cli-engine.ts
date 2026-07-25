/**
 * `OrcaCliEngine` — the first `SlicerEngine` adapter.
 *
 * Everything OrcaSlicer-specific lives in this directory and nothing above the
 * boundary imports it (docs/adr/0001-slicer-engine-boundary.md).
 *
 * The invocation and its non-obvious rules (all from docs/SPEC.md, several of them
 * verified against the pinned 2.4.2 binary in M0):
 *
 *  - `--load-settings` takes the MACHINE profile first, then the process profile.
 *  - `--allow-newer-file` and `--min-save` are always passed.
 *  - `--outputdir` is NEVER combined with an absolute `--export-3mf` (deviation #2):
 *    the two are concatenated into `/work/out//work/out/x.3mf` and the export fails.
 *  - Exit code 0 is necessary but NOT sufficient (deviation #2): the artefact is
 *    asserted to exist, be a readable ZIP and be non-empty before a slice is called a
 *    success.
 *  - `XDG_RUNTIME_DIR` is always set (deviation #7) so stderr stays parseable.
 *  - The child's CWD is the sandbox, and that is load-bearing. MEASURED: with
 *    `--load-assemble-list` the slicer drops `result.json` and a `NNNNN.log` into the
 *    *current working directory* — not into the export directory — so a process started
 *    in the repo or in `/` litters there. Inside the sandbox they die with it.
 *  - Profiles must arrive already flattened (deviation #1). Handing the CLI a preset
 *    with an `inherits` key produces a plausible-looking, wrong result at exit 0, so we
 *    refuse it as a programming error.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PlateStats, SliceStats } from '@orca-web/shared';
import { SliceError } from '../errors.js';
import type {
  ArrangeJob,
  ArrangeResult,
  EngineArtifact,
  EngineInfo,
  SliceArtifacts,
  SliceJob,
  SliceOptions,
  SliceProgress,
  SlicerEngine,
} from '../port.js';
import { buildAssembleList } from './assemble-list.js';
import { matchDiagnostic } from './diagnostics.js';
import { sliceErrorForExit } from './exit-codes.js';
import { ProgressPipe, type RawPipeMessage } from './progress-pipe.js';
import {
  SLICE_INFO_ENTRY,
  decode,
  gcodeEntries,
  layerCountFromGcodeHeader,
  parseSliceInfo,
  patchProjectPrinterModel,
  readArchive,
  readObjectPlacements,
  verifyGcodeChecksum,
  writePlateThumbnail,
} from './threemf.js';

const execFileAsync = promisify(execFile);

/** How long a killed process group gets to die politely before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How long we wait for the FIFO to drain after the child exits. */
const PIPE_DRAIN_MS = 500;
/** Cap on retained engine output. Enough for a diagnosis, bounded for memory. */
const LOG_LIMIT_BYTES = 256 * 1024;

export const PROJECT_ARTIFACT_NAME = 'result.gcode.3mf';

export interface OrcaCliEngineConfig {
  /** Path to (or name on `PATH` of) the slicer binary. */
  binary: string;
  /** Value for `XDG_RUNTIME_DIR` when the environment does not already set one. */
  xdgRuntimeDir?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
}

/** A bounded FIFO of progress updates bridging the pipe callback to the generator. */
class ProgressBuffer {
  private readonly items: SliceProgress[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(item: SliceProgress): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *drain(): AsyncGenerator<SliceProgress, void, void> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift() as SliceProgress;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function formatOverride(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function assertFlattened(profile: SliceJob['machine']): void {
  if ('inherits' in profile.values && profile.values.inherits !== '') {
    // Deviation #1 is a silent failure: bed size and filament density come out wrong and
    // the CLI still exits 0. Failing loudly here is the only way to keep it visible.
    throw new SliceError(
      'PROFILE_INVALID',
      'The server tried to slice with an unresolved profile.',
      {
        hint: 'This is a server-side bug, not a problem with your model.',
        detail: `profile "${profile.name}" (${profile.kind}) still has an inherits key; profiles must be flattened before reaching the engine`,
      },
    );
  }
}

export class OrcaCliEngine implements SlicerEngine {
  readonly id = 'orca-cli';
  private readonly config: OrcaCliEngineConfig;
  private probed: Promise<EngineInfo> | undefined;

  constructor(config: OrcaCliEngineConfig) {
    this.config = config;
  }

  /**
   * MEASURED: *every* invocation writes a `result.json` into the current working
   * directory — including `--help`, which does not slice anything. Probing from the
   * server's own working directory would therefore litter the repo (or `/`), so it runs
   * in a scratch directory, and the answer is cached: the binary is pinned, so its
   * version cannot change under a running process.
   */
  async probe(): Promise<EngineInfo> {
    this.probed ??= (async () => {
      const scratch = join(tmpdir(), 'orca-cli-engine');
      await mkdir(scratch, { recursive: true });
      const { stdout } = await execFileAsync(this.config.binary, ['--help'], {
        cwd: scratch,
        env: this.childEnv(),
        maxBuffer: 4 * 1024 * 1024,
      });
      // First line is `OrcaSlicer-<version>:`.
      const match = /^OrcaSlicer-([0-9][^\s:]*)/.exec(stdout.trim());
      return { id: this.id, version: match?.[1] ?? 'unknown' };
    })().catch((error: unknown) => {
      this.probed = undefined;
      throw error;
    });
    return this.probed;
  }

  private childEnv(workDir?: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // Deviation #7: without this every run writes "error: XDG_RUNTIME_DIR is invalid
      // or not set" to stderr, which pollutes diagnostic matching.
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR ??
        this.config.xdgRuntimeDir ??
        (workDir === undefined ? '/tmp' : join(workDir, 'xdg')),
      ...this.config.env,
    };
  }

  async *slice(
    job: SliceJob,
    options: SliceOptions = {},
  ): AsyncGenerator<SliceProgress, SliceArtifacts> {
    const log = options.onLog ?? (() => undefined);
    const profilesDir = join(job.workDir, 'profiles');
    const outDir = join(job.workDir, 'out');
    const xdgDir = join(job.workDir, 'xdg');
    await Promise.all([
      mkdir(profilesDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
      mkdir(xdgDir, { recursive: true, mode: 0o700 }),
    ]);

    const args = await this.buildArgs(job, profilesDir);
    const exportPath = join(outDir, PROJECT_ARTIFACT_NAME);

    const buffer = new ProgressBuffer();
    const warnings: string[] = [];
    let lastForwarded = 0;
    const interval = options.progressIntervalMs ?? 1_000;

    const onPipeMessage = (raw: RawPipeMessage): void => {
      const progress: SliceProgress = {
        plateIndex: Math.trunc(raw.plate_index ?? 0),
        plateCount: Math.trunc(raw.plate_count ?? 1),
        platePercent: raw.plate_percent ?? 0,
        totalPercent: raw.total_percent ?? 0,
        message: raw.message ?? '',
        warning: typeof raw.warning === 'string' && raw.warning !== '' ? raw.warning : null,
      };
      if (progress.warning !== null && !warnings.includes(progress.warning)) {
        warnings.push(progress.warning);
      }
      // Throttle to roughly one update per second (SPEC). A warning or the terminal
      // 100% is never throttled away — the warning is the user's only signal for
      // things like unsupported overhangs.
      const now = Date.now();
      const forced = progress.warning !== null || progress.totalPercent >= 100;
      if (!forced && now - lastForwarded < interval) return;
      lastForwarded = now;
      buffer.push(progress);
    };

    const pipePath = join(job.workDir, 'progress.pipe');
    const pipe = new ProgressPipe(pipePath, onPipeMessage, (line) =>
      log(`unparseable progress line: ${line}`),
    );
    // Reader first, THEN the child. See progress-pipe.ts for why the reverse deadlocks.
    await pipe.open();
    args.push('--pipe', pipePath);

    const inputArgs = await this.buildInputArgs(job);
    const finalArgs = [...args, '--export-3mf', exportPath, ...inputArgs];
    log(`${this.config.binary} ${finalArgs.map((a) => JSON.stringify(a)).join(' ')}`);

    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length < LOG_LIMIT_BYTES) output += chunk.toString('utf8');
    };

    // `detached: true` makes the child its own process-group leader, so kill(-pid)
    // reaches the slicer and every helper it spawned and nothing else.
    const child = spawn(this.config.binary, finalArgs, {
      // Not cosmetic: the slicer writes result.json / NNNNN.log relative to CWD.
      cwd: job.workDir,
      detached: true,
      env: this.childEnv(job.workDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let killed: 'timeout' | 'cancelled' | undefined;
    let running = true;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!running || child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const exited = new Promise<ChildOutcome>((resolve, reject) => {
      child.once('error', (error) => {
        running = false;
        reject(
          new SliceError('ENVIRONMENT_ERROR', 'The slicer could not be started.', {
            hint: 'This is a server-side problem, not a problem with your model.',
            retryable: true,
            detail: String(error),
            cause: error,
          }),
        );
      });
      child.once('exit', (status, signal) => {
        running = false;
        resolve({ status, signal });
      });
    });

    const hardKill = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      killed = 'timeout';
      hardKill();
    }, job.limits.wallClockMs);
    timer.unref();

    const onAbort = (): void => {
      killed = 'cancelled';
      hardKill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    // Close the progress stream once the child is gone and the FIFO has drained.
    const finished = exited.then(
      async (outcome) => {
        await new Promise((resolve) => setTimeout(resolve, PIPE_DRAIN_MS).unref?.());
        await pipe.close();
        buffer.close();
        return outcome;
      },
      async (error) => {
        await pipe.close();
        buffer.close();
        throw error;
      },
    );
    // Never let a rejection here become an unhandled rejection while we are yielding.
    finished.catch(() => undefined);

    try {
      for await (const progress of buffer.drain()) {
        yield progress;
      }

      const outcome = await finished;
      this.assertSucceeded(outcome, killed, output);
      return await this.collectArtifacts(exportPath, outDir, warnings, output);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Runs on success, failure, timeout AND cancellation (including a caller
      // `break`ing out of the iteration, which calls .return() on this generator).
      if (running) {
        hardKill();
        await Promise.race([
          exited.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 1_000).unref?.()),
        ]);
      }
      await pipe.close().catch(() => undefined);
      buffer.close();
    }
  }

  // -------------------------------------------------------------------------
  // Arranging
  // -------------------------------------------------------------------------

  /**
   * `--arrange 1`, and then read back where things landed.
   *
   * MEASURED on 2.4.2, and the reason this is not simply "add `--arrange 1` to the slice":
   *
   *  - **`--arrange 1` and `--load-assemble-list` are mutually exclusive.** Combining them
   *    fails immediately with `-2` (`CLI_INVALID_PARAMS`, shell status 254) and writes no
   *    output, with or without `--slice`. Arranging therefore takes positional model paths
   *    — one per *instance*, since a plate description's `count` has no equivalent here.
   *  - The machine profile still has to be passed: the bed it packs into comes from
   *    `printable_area` / `bed_exclude_area`, and an unflattened profile would silently
   *    pack into the compiled-in 200×200 default (deviation #1).
   *  - No `--slice`, no `--min-save`: this exports a project 3MF purely so the placements
   *    can be read out of it, and `--min-save` would drop the meshes' own `3D/Objects`
   *    entries (deviation #5) that the placement maths uses.
   */
  async arrange(job: ArrangeJob, options: { signal?: AbortSignal } = {}): Promise<ArrangeResult> {
    if (job.objects.length === 0) return { placements: [] };
    assertFlattened(job.machine);
    assertFlattened(job.process);

    const dir = join(job.workDir, 'arrange');
    await mkdir(dir, { recursive: true });
    const machinePath = join(dir, 'machine.json');
    const processPath = join(dir, 'process.json');
    await writeFile(machinePath, JSON.stringify(job.machine.values, null, 2));
    await writeFile(processPath, JSON.stringify(job.process.values, null, 2));

    // Staged under unique names so the placements can be matched back to their instance:
    // the export identifies objects by file name, and two copies of one model would
    // otherwise be indistinguishable.
    const names = job.objects.map((_, index) => `${index}.stl`);
    await Promise.all(
      job.objects.map(async (object, index) =>
        copyFile(object.path, join(dir, names[index] as string)),
      ),
    );

    const exportPath = join(dir, 'arranged.3mf');
    const args = [
      '--arrange',
      '1',
      '--load-settings',
      `${machinePath};${processPath}`,
      '--allow-newer-file',
      '--debug',
      '2',
      '--export-3mf',
      exportPath,
      ...names.map((name) => join(dir, name)),
    ];

    const outcome = await this.runOnce(args, dir, job.wallClockMs, options.signal);
    if (outcome.status !== 0) {
      throw (
        matchDiagnostic(outcome.output) ??
        sliceErrorForExit(outcome.status ?? -1, outcome.output.slice(-4_000))
      );
    }
    // Deviation #2's durable rule: the exit status alone is never a success signal.
    const entries = await readArchive(exportPath).catch(() => undefined);
    if (entries === undefined) {
      throw new SliceError('EXPORT_FAILED', 'The plate could not be arranged.', {
        hint: 'Try moving the objects yourself.',
        retryable: true,
        detail: outcome.output.slice(-4_000),
      });
    }

    const byName = new Map(
      readObjectPlacements(entries).map((placement) => [placement.name, placement]),
    );
    return {
      placements: names.map((name, index) => {
        const placement = byName.get(name);
        if (!placement) {
          throw new SliceError('EXPORT_FAILED', 'The arranged plate came back incomplete.', {
            retryable: true,
            detail: `no placement for object ${index} (${name}); got ${[...byName.keys()].join(', ')}`,
          });
        }
        return { position: placement.position, rotation: placement.rotation };
      }),
    };
  }

  /** Put a client-rendered preview into the archive. See threemf.ts and deviation #5. */
  async embedPlateThumbnail(artifactPath: string, plate: number, png: Uint8Array): Promise<number> {
    const { bytes } = await writePlateThumbnail(artifactPath, plate, png);
    return bytes;
  }

  /**
   * Run the binary once and collect its output. Used by the short, non-streaming
   * invocations; `slice()` drives its own child because it also owns a FIFO reader, a
   * progress buffer and a cancellation contract.
   */
  private async runOnce(
    args: string[],
    cwd: string,
    wallClockMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      // cwd is the sandbox: every invocation drops result.json where it starts (#9).
      const child = spawn(this.config.binary, args, {
        cwd,
        detached: true,
        env: this.childEnv(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const collect = (chunk: Buffer): void => {
        if (output.length < LOG_LIMIT_BYTES) output += chunk.toString('utf8');
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const kill = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(kill, wallClockMs);
      timer.unref();
      signal?.addEventListener('abort', kill, { once: true });

      child.once('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        reject(
          new SliceError('ENVIRONMENT_ERROR', 'The slicer could not be started.', {
            hint: 'This is a server-side problem, not a problem with your model.',
            retryable: true,
            detail: String(error),
            cause: error,
          }),
        );
      });
      child.once('exit', (status) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        if (signal?.aborted === true) {
          reject(new SliceError('CANCELLED', 'The job was cancelled.', { retryable: true }));
          return;
        }
        resolve({ status, output });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Argument construction
  // -------------------------------------------------------------------------

  private async buildArgs(job: SliceJob, profilesDir: string): Promise<string[]> {
    assertFlattened(job.machine);
    assertFlattened(job.process);
    for (const filament of job.filaments) assertFlattened(filament);
    if (job.filaments.length === 0) {
      throw new SliceError('INVALID_PARAMS', 'A job needs at least one filament.', {
        hint: 'Pick a filament and try again.',
      });
    }

    const machinePath = join(profilesDir, 'machine.json');
    const processPath = join(profilesDir, 'process.json');
    await writeFile(machinePath, JSON.stringify(job.machine.values, null, 2));
    await writeFile(processPath, JSON.stringify(job.process.values, null, 2));

    const filamentPaths: string[] = [];
    for (const [index, filament] of job.filaments.entries()) {
      const path = join(profilesDir, `filament-${index + 1}.json`);
      await writeFile(path, JSON.stringify(filament.values, null, 2));
      filamentPaths.push(path);
    }

    const args = [
      '--slice',
      String(job.plate),
      // Order matters: machine first, then process.
      '--load-settings',
      `${machinePath};${processPath}`,
      '--load-filaments',
      filamentPaths.join(';'),
      '--allow-newer-file',
      '--min-save',
      '--debug',
      '2',
      // Engine-side second line of defence behind the wall-clock timeout.
      '--mstpp',
      String(job.limits.maxSecondsPerPlate),
      '--mtcpp',
      String(job.limits.maxTrianglesPerPlate),
    ];

    if (job.filamentColours && job.filamentColours.length > 0) {
      // Deviation #3: `--filament-colour` is not advertised in 2.4.2's --help. It is
      // accepted as a raw PrintConfig key, so it is only passed when a caller asked
      // for it and never load-bearing.
      args.push('--filament-colour', job.filamentColours.join(';'));
    }

    for (const [key, value] of Object.entries(job.overrides)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw new SliceError('INVALID_PARAMS', `"${key}" is not a valid setting name.`, {
          hint: 'Setting names are lower-case identifiers such as `layer_height`.',
        });
      }
      args.push(`--${key.replace(/_/g, '-')}`, formatOverride(value));
    }

    return args;
  }

  /**
   * Geometry arguments. Positional model paths must come last.
   *
   * A 3MF being re-targeted at another printer gets its `printer_model` patched into a
   * sandbox copy first (SPEC gotcha) — the library blob itself is content-addressed and
   * must never be mutated.
   */
  private async buildInputArgs(job: SliceJob): Promise<string[]> {
    if (job.input.kind === 'plates') {
      const list = buildAssembleList(job.input.plates);
      const path = join(job.workDir, 'assemble-list.json');
      await writeFile(path, JSON.stringify(list, null, 2));
      return ['--load-assemble-list', path];
    }

    const printerModel = job.machine.values.printer_model;
    const paths: string[] = [];
    for (const [index, source] of job.input.paths.entries()) {
      if (typeof printerModel === 'string' && source.toLowerCase().endsWith('.3mf')) {
        const patchedPath = join(job.workDir, `input-${index + 1}.3mf`);
        try {
          const result = await patchProjectPrinterModel(source, patchedPath, printerModel);
          if (result.patched) {
            paths.push(patchedPath);
            continue;
          }
        } catch (error) {
          throw new SliceError('INPUT_UNREADABLE', 'The uploaded project file could not be read.', {
            hint: 'Re-export it from OrcaSlicer, or upload the model on its own.',
            detail: String(error),
            cause: error,
          });
        }
      }
      paths.push(source);
    }
    return paths;
  }

  // -------------------------------------------------------------------------
  // Result validation
  // -------------------------------------------------------------------------

  private assertSucceeded(
    outcome: ChildOutcome,
    killed: 'timeout' | 'cancelled' | undefined,
    output: string,
  ): void {
    if (killed === 'cancelled') {
      throw new SliceError('CANCELLED', 'The job was cancelled.', { retryable: true });
    }
    if (killed === 'timeout') {
      throw new SliceError('TIMEOUT', 'Slicing took longer than this server allows.', {
        hint: 'Use a larger layer height, fewer objects, or a simpler model.',
        detail: output.slice(-4_000),
      });
    }
    if (outcome.signal !== null) {
      throw new SliceError('ENGINE_CRASHED', 'The slicer stopped unexpectedly.', {
        hint: 'Try again; if it keeps happening the model is likely at fault.',
        retryable: true,
        detail: `killed by ${outcome.signal}\n${output.slice(-4_000)}`,
      });
    }
    if (outcome.status !== 0) {
      // A recognised diagnostic beats the exit-code table: it is strictly more specific.
      const diagnosed = matchDiagnostic(output);
      throw diagnosed ?? sliceErrorForExit(outcome.status ?? -1, output.slice(-4_000));
    }
  }

  private async collectArtifacts(
    exportPath: string,
    outDir: string,
    warnings: string[],
    output: string,
  ): Promise<SliceArtifacts> {
    // Deviation #2: a failed export still exits 0, so exit status is never a sufficient
    // success signal. The artefact has to be there, and has to be real.
    const exported = await stat(exportPath).catch(() => undefined);
    if (exported === undefined) {
      throw (
        matchDiagnostic(output) ??
        new SliceError('ARTIFACT_MISSING', 'The slicer reported success but produced no output.', {
          hint: 'This is a server-side problem; please try again.',
          retryable: true,
          detail: output.slice(-4_000),
        })
      );
    }
    const bytes = exported.size;
    if (bytes === 0) {
      throw new SliceError('EXPORT_FAILED', 'The slicer produced an empty result file.', {
        retryable: true,
        detail: output.slice(-4_000),
      });
    }

    let entries;
    try {
      entries = await readArchive(exportPath);
    } catch (error) {
      throw new SliceError('EXPORT_FAILED', 'The slicer produced an unreadable result file.', {
        retryable: true,
        detail: `${String(error)}\n${output.slice(-4_000)}`,
        cause: error,
      });
    }

    const files: EngineArtifact[] = [
      {
        name: PROJECT_ARTIFACT_NAME,
        path: exportPath,
        bytes,
        contentType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
        role: 'project',
      },
    ];

    // Offer the raw G-code too: some printers want the .3mf, others want the .gcode.
    const gcodes = gcodeEntries(entries);
    if (gcodes.length === 0) {
      throw new SliceError('ARTIFACT_MISSING', 'The result contains no G-code.', {
        hint: 'This is a server-side problem; please try again.',
        retryable: true,
        detail: `archive members: ${Object.keys(entries).join(', ')}`,
      });
    }

    let headerLayerCount: number | null = null;
    for (const gcode of gcodes) {
      const data = entries[gcode.name] as Uint8Array;
      if (!verifyGcodeChecksum(entries, gcode.name)) {
        throw new SliceError('EXPORT_FAILED', 'The generated G-code failed its checksum.', {
          retryable: true,
          detail: `${gcode.name} does not match its recorded md5`,
        });
      }
      const name = `plate_${gcode.plate}.gcode`;
      const path = join(outDir, name);
      await writeFile(path, data);
      if (headerLayerCount === null) {
        headerLayerCount = layerCountFromGcodeHeader(decode(data.subarray(0, 64 * 1024)));
      }
      files.push({
        name,
        path,
        bytes: data.byteLength,
        contentType: 'text/x.gcode',
        role: 'gcode',
        plate: gcode.plate,
      });
    }

    const infoEntry = entries[SLICE_INFO_ENTRY];
    const plates: PlateStats[] = infoEntry ? parseSliceInfo(decode(infoEntry)) : [];
    if (plates.length === 0) {
      throw new SliceError('ARTIFACT_MISSING', 'The slicer produced no slice report.', {
        hint: 'This is a server-side problem; please try again.',
        retryable: true,
        detail: `archive members: ${Object.keys(entries).join(', ')}`,
      });
    }
    for (const plate of plates) {
      if (plate.layerCount === null) plate.layerCount = headerLayerCount;
    }

    const stats: SliceStats = {
      predictionSeconds: plates.reduce((sum, plate) => sum + plate.predictionSeconds, 0),
      weightGrams: plates.reduce((sum, plate) => sum + plate.weightGrams, 0),
      totalMetres: plates.reduce(
        (sum, plate) => sum + plate.filaments.reduce((s, f) => s + f.usedMetres, 0),
        0,
      ),
      layerCount: plates.reduce<number | null>(
        (max, plate) =>
          plate.layerCount === null
            ? max
            : max === null
              ? plate.layerCount
              : Math.max(max, plate.layerCount),
        null,
      ),
      plates,
    };

    if (stats.weightGrams === 0) {
      // Deviation #1's signature symptom: filament_density fell back to the compiled-in
      // default of 0 because a preset reached the CLI unflattened. Slicing "succeeded",
      // but the numbers are wrong, so this is a failure, not a warning.
      throw new SliceError('PROFILE_INVALID', 'The slice produced an implausible result.', {
        hint: 'This is a server-side problem with the selected filament profile.',
        detail:
          'slice_info reported used_g = 0, which means filament_density was 0 — the filament preset almost certainly reached the CLI with an unresolved inherits chain',
      });
    }

    return { files, stats, warnings };
  }
}
