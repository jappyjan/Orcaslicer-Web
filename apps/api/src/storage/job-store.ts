/**
 * Job metadata in SQLite. Blobs on the filesystem, everything else here.
 */

import type {
  ApiError,
  ArtifactSummary,
  JobRequest,
  JobState,
  JobSummary,
  ModelSummary,
  SliceStats,
} from '@orca-web/shared';
import type { Db } from './db.js';

interface JobRow {
  id: string;
  name: string | null;
  state: string;
  request: string;
  models: string;
  percent: number;
  message: string | null;
  warnings: string;
  artifacts: string;
  stats: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export interface CreateJobInput {
  id: string;
  name: string | null;
  request: JobRequest;
  models: ModelSummary[];
}

export class JobStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: CreateJobInput): JobSummary {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, state, request, models, percent, warnings, artifacts, created_at)
         VALUES (?, ?, 'queued', ?, ?, 0, '[]', '[]', ?)`,
      )
      .run(input.id, input.name, JSON.stringify(input.request), JSON.stringify(input.models), now);
    return this.get(input.id) as JobSummary;
  }

  private row(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  get(id: string): JobSummary | undefined {
    const row = this.row(id);
    return row ? this.toSummary(row) : undefined;
  }

  getRequest(id: string): JobRequest | undefined {
    const row = this.row(id);
    return row ? (JSON.parse(row.request) as JobRequest) : undefined;
  }

  list(limit = 50): JobSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as JobRow[];
    return rows.map((row) => this.toSummary(row));
  }

  state(id: string): JobState | undefined {
    const row = this.db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as
      { state: string } | undefined;
    return row ? (row.state as JobState) : undefined;
  }

  markRunning(id: string): void {
    this.db
      .prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  setProgress(id: string, percent: number, message: string, warnings: readonly string[]): void {
    this.db
      .prepare('UPDATE jobs SET percent = ?, message = ?, warnings = ? WHERE id = ?')
      .run(percent, message, JSON.stringify(warnings), id);
  }

  markSucceeded(
    id: string,
    stats: SliceStats,
    artifacts: readonly ArtifactSummary[],
    warnings: readonly string[],
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'succeeded', percent = 100, finished_at = ?, stats = ?,
         artifacts = ?, warnings = ?, error = NULL WHERE id = ?`,
      )
      .run(
        Date.now(),
        JSON.stringify(stats),
        JSON.stringify(artifacts),
        JSON.stringify(warnings),
        id,
      );
  }

  markFinished(
    id: string,
    state: Extract<JobState, 'failed' | 'cancelled'>,
    error: ApiError,
  ): void {
    this.db
      .prepare('UPDATE jobs SET state = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(state, Date.now(), JSON.stringify(error), id);
  }

  /**
   * Boot-time reconciliation: the in-process queue is not durable (ADR 0002), so a
   * restart leaves rows claiming to be queued or running forever. Mark them once, at
   * start, so nothing is silently stuck.
   */
  interruptStale(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM jobs WHERE state IN ('queued', 'running')")
      .all() as Array<{ id: string }>;
    const error: ApiError = {
      code: 'INTERNAL',
      message: 'The server restarted while this job was running.',
      hint: 'Submit it again.',
      retryable: true,
    };
    this.db
      .prepare(
        "UPDATE jobs SET state = 'interrupted', finished_at = ?, error = ? WHERE state IN ('queued', 'running')",
      )
      .run(Date.now(), JSON.stringify(error));
    return rows.map((row) => row.id);
  }

  /** Model ids referenced by unfinished jobs; the sweeper must not evict these. */
  activeModelIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT models FROM jobs WHERE state IN ('queued', 'running')")
      .all() as Array<{ models: string }>;
    const ids = new Set<string>();
    for (const row of rows) {
      for (const model of parse<ModelSummary[]>(row.models, [])) ids.add(model.id);
    }
    return ids;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  /** Ids of finished jobs older than the retention window, for artefact sweeping. */
  expiredJobIds(retentionMs: number): string[] {
    const cutoff = Date.now() - retentionMs;
    const rows = this.db
      .prepare(
        "SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND state != 'running'",
      )
      .all(cutoff) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private toSummary(row: JobRow): JobSummary {
    return {
      id: row.id,
      name: row.name,
      state: row.state as JobState,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      percent: row.percent,
      message: row.message,
      warnings: parse<string[]>(row.warnings, []),
      models: parse<ModelSummary[]>(row.models, []),
      artifacts: parse<ArtifactSummary[]>(row.artifacts, []),
      stats: row.stats === null ? null : parse<SliceStats | null>(row.stats, null),
      error: row.error === null ? null : parse<ApiError | null>(row.error, null),
    };
  }
}
