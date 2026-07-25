# ADR 0001 — The `SlicerEngine` boundary

- **Status:** accepted
- **Date:** M1
- **Deciders:** M1 (slice service)
- **Supersedes / superseded by:** —

## Context

We need to turn "a user's model plus some presets" into "G-code" without owning a
slicing engine. OrcaSlicer is AGPL-3.0, ships a capable CLI, and is under active
development (its CLI surface moves between releases without release notes).

Two ways to use it:

1. **Link `libslic3r`** into our process. Fastest path for progress reporting and
   in-memory geometry, but it makes our server a derived work of an AGPL library,
   pins us to a C++ ABI, and turns every upstream release into a rebase-and-rebuild
   exercise. We would also inherit crashes: a segfault in a slicing thread takes the
   API down with it.
2. **Shell out to the unmodified release binary.** A process boundary, a documented
   text interface, and an upgrade story that is a version bump in one `ARG`.

## Decision

**We shell out to a pinned, unmodified OrcaSlicer release binary as a child process,
behind a `SlicerEngine` port.** (Hard constraints #1 and #3.)

### Why the process boundary is the point, not an implementation detail

- **Licensing.** We ship the binary as-is and invoke it over a CLI. Our code is not a
  derived work of `libslic3r`; `AGPL-NOTICE.md` records the version and where its
  source can be obtained. Linking would put the entire API under AGPL-3.0.
- **Upgrade cost.** Upstream changes `PrintConfig.cpp` constantly and the CLI surface
  with it. A pinned binary plus a golden `--help` diff (hard constraint #2) turns
  "did the interface change?" into a CI failure instead of a runtime surprise.
- **Fault isolation.** A slice that runs out of memory, deadlocks, or segfaults kills
  one child process. The API survives, reports a typed error, and deletes the sandbox.
- **Resource control.** A separate process can be given a wall-clock deadline and
  killed by process group. There is no equivalent for a runaway in-process thread.

The costs we accept: we can only observe the engine through stdout/stderr, a progress
FIFO and an exit code; and every slice pays process-startup and file-marshalling cost
(measured at well under a second against multi-second slices — irrelevant).

### The port

```ts
interface SlicerEngine {
  readonly id: string;
  slice(job: SliceJob, options?: SliceOptions): AsyncGenerator<SliceProgress, SliceArtifacts>;
  probe(): Promise<EngineInfo>;
}
```

`slice` is an **async generator**: iterating yields `SliceProgress`, and the generator's
_return value_ is the `SliceArtifacts`. That is the spec's
`slice(job): AsyncIterable<Progress> -> Artifacts` expressed directly in TypeScript —
one call produces both the stream and the result, so there is no way to observe progress
for a slice you did not start, and no second "get result" call that could disagree with
the stream. `for await` discards the return value by design, so callers use the
`runSlice()` helper (`engine/run.ts`), which drives the iterator manually.

`SliceJob` is deliberately engine-agnostic:

- Profiles arrive as `ResolvedProfile` **records**, not file paths and not INI text.
  The adapter serialises them into whatever its engine reads. A PrusaSlicer adapter
  would write `.ini`; the Orca adapter writes JSON.
- Geometry arrives as either a list of file paths or a list of **plates** with
  per-object transforms — a vocabulary all three candidate engines can express.
- Limits (`wallClockMs`, `maxSecondsPerPlate`, `maxTrianglesPerPlate`) are stated as
  intent; enforcing them is the adapter's problem.

### What lives above the boundary

Job identity and persistence, the queue, the sandbox lifecycle, HTTP/SSE, the model
library, quota enforcement, retry policy, and the user-facing error vocabulary
(`SliceErrorCode`). None of it may mention OrcaSlicer, `--load-settings`,
`.gcode.3mf`, or an exit code.

### What lives below it

Argument construction and ordering (machine before process, `--allow-newer-file`,
`--min-save`, never `--outputdir` with an absolute `--export-3mf`), the FIFO progress
protocol, the exit-code table from `src/libslic3r/Utils.hpp`, stderr diagnostic
matching, 3MF archive reading and `printer_model` patching, and
`slice_info.config` parsing. All of it is under `engine/orca/`.

**Profile flattening is above the boundary, not below it.** The CLI does not resolve
`inherits` and fails silently when it is not done (verified deviation #1), but that is
a property of the _profile data_, not of the engine, and M2's catalog will do it for
every engine. The port therefore requires already-flattened `ResolvedProfile` values,
and the adapter asserts it (`inherits` present ⇒ programming error, not a slice error).

### How progress crosses

The adapter creates a FIFO with `mkfifo`, **opens the read end before spawning the
child** (open-for-read on a FIFO blocks until a writer appears, and the child blocks
opening the write end until a reader does — get the order wrong and you deadlock or
lose the first lines), and parses one JSON object per line. It normalises Orca's
`{plate_index, plate_percent, total_percent, message, warning}` into the port's
`SliceProgress` and **throttles to one update per `progressIntervalMs` (default 1 s)**
— except for messages carrying a `warning`, which are always forwarded, and the
terminal 100 %.

### How cancellation crosses

Two mechanisms, both landing in the same place:

- `options.signal` (an `AbortSignal`) — used by the queue and by `DELETE /jobs/:id`.
- Calling `.return()` on the generator (i.e. `break`ing out of a `for await`).

Both cause the adapter's `finally` block to kill the **process group** (`SIGTERM`, then
`SIGKILL` after a grace period). The child is spawned `detached: true` so it is its own
process-group leader and `process.kill(-pid)` cannot reach anything else. Nothing is
awaited on a cancelled child beyond its exit; sandbox removal is the caller's `finally`
(see `sandbox.ts`), which runs on success, failure, timeout and cancellation alike.

### Success is never "exit code 0"

Verified deviation #2: a failed export can still exit 0. The adapter therefore treats a
zero exit as _necessary but not sufficient_ and additionally asserts the artefact exists,
is a readable ZIP, and is non-empty. A non-zero exit maps through the upstream table to a
`SliceErrorCode`; a zero exit with no artefact maps to `ARTIFACT_MISSING`.

## Consequences

### A second adapter

PrusaSlicer and Bambu Studio have near-identical CLIs (all three are Slic3r
descendants). A `PrusaCliEngine` would **reuse**: the port and its types, the
sandbox, the queue, the progress throttle and the SSE transport, the job store, the
error vocabulary, `runSlice()`, and the model library.

It would have to **reimplement**: argument construction and profile serialisation
(`.ini`, not JSON, and `--load` rather than `--load-settings`); the progress channel
(PrusaSlicer has no `--pipe` — progress would have to come from stdout parsing, which is
exactly why `SliceProgress` is defined in terms of percent + message and not in terms of
Orca's pipe schema); the exit-code table; and the output-artefact layout (a bare
`.gcode`, not a `.gcode.3mf`, so `SliceArtifacts.projectFile` becomes optional in
practice). Everything Orca-shaped is already in `engine/orca/` and nothing above the
boundary imports from that directory — that invariant is what makes the estimate real.

### Testable

Unit tests use `MockSlicerEngine`, a real implementation of the port, for the happy
path and for cancellation/timeout semantics. The acceptance test uses the real binary in
the container and is not permitted to mock it (working agreement).
