import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types.js';
import type { StepProgressEntry } from './check-run-summary.js';

/**
 * Matches the table primary key `(provider, owner, repo, sha, check_name)`. Also the
 * L1 in-memory cache key.
 */
export interface CheckRunTrackingKey {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  checkName: string;
}

/** Mirrors the `check_run_tracking` columns, in the in-memory shapes the consumer uses. */
export interface CheckRunTrackingState {
  /** GitHub Checks API check-run ID. Undefined when not yet created. */
  checkRunId?: number;
  buildCreationState?: 'pending' | 'completed';
  /** Live step-progress entries shown in the check run's `output.summary`. */
  stepProgress: StepProgressEntry[];
  /** When the first running-step transition was sent to GitHub. */
  inProgressSentAt?: Date;
  /**
   * When the provider accepted the terminal (`completed`) update.
   * Undefined means no record of sending it — not proof it failed.
   */
  terminalSentAt?: Date;
  /**
   * Owning KiCI run, written at create time. An attribution/lookup key, not a
   * retention key — the sweep prunes on `updated_at` age alone.
   */
  runId?: string;
  /** Last persisted update time; powers debounce-after-failover recovery. */
  updatedAt?: Date;
}

/**
 * DB persistence for `CheckRunReporter` check-run state, one `check_run_tracking` row per
 * `(provider, owner, repo, sha, check_name)`. The reporter's in-memory maps persist as:
 *
 *   - `checkRunIds`            → `check_run_id` column
 *   - `pendingBuildCreations`  → `build_creation_state` column
 *   - `stepProgress`           → `step_progress_json` column
 *   - `inProgressSent`         → `in_progress_sent_at` column
 *   - `runIdToKeys`            → indexed `run_id` column + `listKeysByRunId`
 *
 * `progressTimers` is intentionally NOT persisted: after a coord failover the next
 * `updateStepProgress` either flushes immediately (debounce window elapsed) or starts a
 * fresh timer.
 *
 * The consumer keeps an L1 in-memory cache in front; the store is stateless beyond its
 * connection.
 */
export class CheckRunTrackingStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert, so a re-issued setPending after a coord failover replaces the prior ID rather
   * than leaving the row mismatched with the GitHub-side state.
   *
   * Pass `runId`: a row created without it carries a NULL `run_id`, which makes
   * `listKeysByRunId` under-report and hides which run posted a given check.
   */
  async setCheckRunId(key: CheckRunTrackingKey, checkRunId: number, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      check_run_id: checkRunId,
      ...(runId !== undefined && { run_id: runId }),
      // A new check-run id is a NEW check run whose terminal update is not sent yet. A
      // re-run at the same commit lands on the same row, so without this reset it would
      // inherit the previous run's completion and have its live step progress suppressed.
      terminal_sent_at: null,
    });
  }

  /**
   * Undefined if no row exists yet OR the GitHub create has not persisted an ID yet
   * (the build-creation in-flight window).
   */
  async getCheckRunId(key: CheckRunTrackingKey): Promise<number | undefined> {
    const row = await this.selectRow(key);
    if (!row) return undefined;
    if (row.check_run_id == null) return undefined;
    // Postgres BIGINT lands as a string when going through pg; coerce defensively.
    return typeof row.check_run_id === 'string' ? Number(row.check_run_id) : row.check_run_id;
  }

  /**
   * Mark a build check-run as having an in-flight create (a plain upsert; it
   * does not report whether this caller won a race). Used to prevent a
   * replacement coord from re-issuing a `checks.create()` against the same SHA
   * when the original create is still pending.
   */
  async markBuildCreationPending(key: CheckRunTrackingKey, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      build_creation_state: 'pending',
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /** Idempotent. */
  async markBuildCreationComplete(key: CheckRunTrackingKey): Promise<void> {
    await this.upsertRow(key, { build_creation_state: 'completed' });
  }

  async setStepProgress(
    key: CheckRunTrackingKey,
    steps: StepProgressEntry[],
    runId?: string,
  ): Promise<void> {
    await this.upsertRow(key, {
      step_progress_json: JSON.stringify(steps),
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /** Keeps the "already kicked this check run into in_progress?" guard cluster-wide. */
  async markInProgressSent(key: CheckRunTrackingKey, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      in_progress_sent_at: new Date(),
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /**
   * Mirrors `markInProgressSent`. Best-effort like every write on this table — the caller
   * swallows failures, because a tracking write must never break check-run reporting — so
   * a null column is "no record", not "never sent".
   */
  async markTerminalSent(key: CheckRunTrackingKey, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      terminal_sent_at: new Date(),
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /** Hydrates the L1 cache on miss; tests use it to verify the on-disk layout. */
  async getState(key: CheckRunTrackingKey): Promise<CheckRunTrackingState | undefined> {
    const row = await this.selectRow(key);
    if (!row) return undefined;
    return rowToState(row);
  }

  /** Returns true if the row existed. */
  async deleteRow(key: CheckRunTrackingKey): Promise<boolean> {
    const result = await this.db
      .deleteFrom('check_run_tracking')
      .where('provider', '=', key.provider)
      .where('owner', '=', key.owner)
      .where('repo', '=', key.repo)
      .where('sha', '=', key.sha)
      .where('check_name', '=', key.checkName)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * The runId → keys reverse index `CheckRunReporter` otherwise holds only in memory, so a
   * replacement coord that never saw the run can still recover it. Index
   * `idx_check_run_tracking_run_id` keeps this O(matches).
   *
   * No caller in tree: row lifetime is {@link pruneStale}'s job. Kept as the read half of
   * the `run_id` column, beside {@link deleteByRunId}.
   */
  async listKeysByRunId(runId: string): Promise<CheckRunTrackingKey[]> {
    const rows = await this.db
      .selectFrom('check_run_tracking')
      .select(['provider', 'owner', 'repo', 'sha', 'check_name'])
      .where('run_id', '=', runId)
      .execute();
    return rows.map((row) => ({
      provider: row.provider,
      owner: row.owner,
      repo: row.repo,
      sha: row.sha,
      checkName: row.check_name,
    }));
  }

  /**
   * Targeted escape hatch for deliberately discarding one run's rows; routine reclamation
   * is {@link pruneStale}. Not on the run-prune path: `cleanupRun` evicts only in-memory
   * state, because a row deleted at prune time strands a late terminal PATCH that still
   * has to resolve its check-run ID.
   */
  async deleteByRunId(runId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('check_run_tracking')
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  /**
   * Delete rows untouched for longer than `retentionDays`; returns the count.
   * `retentionDays <= 0` disables the sweep (the `JobQueue.pruneTerminalDispatchRows`
   * convention). Called from the hourly cleanup tick.
   *
   * The predicate is `updated_at` age alone, deliberately unfiltered by `run_id`: the
   * table has no status column, and the rows that most need reaping have no `run_id` to
   * join on. Every upsert bumps `updated_at`, so a run still emitting check-run traffic
   * keeps its rows fresh; a workflow-level row, written once at create, ages from creation.
   *
   * Inactivity age rather than run completion keeps a reader safe: a row a diagnostic is
   * polling cannot vanish underneath it, because the window is days.
   *
   * The trade-off: a run that stays live with no check-run traffic for longer than the
   * window — e.g. parked on a manual approval gate, whose hold statuses go through
   * `CheckStatusPoster` and never touch this table — has its rows swept while running. The
   * reporter's L1 cache still holds the ID, so the terminal update lands on a coord that
   * stayed up; only a restart or failover across that window leaves it with no row and no
   * check-run ID to resolve.
   */
  async pruneStale(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const result = await this.db
      .deleteFrom('check_run_tracking')
      .where('updated_at', '<', sql<Date>`now() - make_interval(days => ${retentionDays})`)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async selectRow(key: CheckRunTrackingKey): Promise<
    | {
        check_run_id: number | string | null;
        build_creation_state: string | null;
        step_progress_json: unknown;
        in_progress_sent_at: Date | null;
        terminal_sent_at: Date | null;
        run_id: string | null;
        updated_at: Date;
      }
    | undefined
  > {
    const row = await this.db
      .selectFrom('check_run_tracking')
      .select([
        'check_run_id',
        'build_creation_state',
        'step_progress_json',
        'in_progress_sent_at',
        'terminal_sent_at',
        'run_id',
        'updated_at',
      ])
      .where('provider', '=', key.provider)
      .where('owner', '=', key.owner)
      .where('repo', '=', key.repo)
      .where('sha', '=', key.sha)
      .where('check_name', '=', key.checkName)
      .executeTakeFirst();
    return row;
  }

  private async upsertRow(
    key: CheckRunTrackingKey,
    updates: Partial<{
      check_run_id: number;
      build_creation_state: string;
      step_progress_json: string;
      in_progress_sent_at: Date;
      /** `null` clears a stale marker; see `setCheckRunId`. */
      terminal_sent_at: Date | null;
      run_id: string;
    }>,
  ): Promise<void> {
    await this.db
      .insertInto('check_run_tracking')
      .values({
        provider: key.provider,
        owner: key.owner,
        repo: key.repo,
        sha: key.sha,
        check_name: key.checkName,
        ...(updates.check_run_id !== undefined && { check_run_id: updates.check_run_id }),
        ...(updates.build_creation_state !== undefined && {
          build_creation_state: updates.build_creation_state,
        }),
        ...(updates.step_progress_json !== undefined && {
          step_progress_json: updates.step_progress_json,
        }),
        ...(updates.in_progress_sent_at !== undefined && {
          in_progress_sent_at: updates.in_progress_sent_at,
        }),
        ...(updates.terminal_sent_at !== undefined && {
          terminal_sent_at: updates.terminal_sent_at,
        }),
        ...(updates.run_id !== undefined && { run_id: updates.run_id }),
      })
      .onConflict((oc) =>
        oc.columns(['provider', 'owner', 'repo', 'sha', 'check_name']).doUpdateSet({
          ...(updates.check_run_id !== undefined && { check_run_id: updates.check_run_id }),
          ...(updates.build_creation_state !== undefined && {
            build_creation_state: updates.build_creation_state,
          }),
          ...(updates.step_progress_json !== undefined && {
            step_progress_json: updates.step_progress_json,
          }),
          ...(updates.in_progress_sent_at !== undefined && {
            in_progress_sent_at: updates.in_progress_sent_at,
          }),
          ...(updates.terminal_sent_at !== undefined && {
            terminal_sent_at: updates.terminal_sent_at,
          }),
          ...(updates.run_id !== undefined && { run_id: updates.run_id }),
          updated_at: sql`NOW()`,
        }),
      )
      .execute();
  }
}

/** Exported for tests that bypass the store. */
export function rowToState(row: {
  check_run_id: number | string | null;
  build_creation_state: string | null;
  step_progress_json: unknown;
  in_progress_sent_at: Date | null;
  terminal_sent_at: Date | null;
  run_id: string | null;
  updated_at: Date;
}): CheckRunTrackingState {
  let stepProgress: StepProgressEntry[] = [];
  if (row.step_progress_json != null) {
    // pg's jsonb columns arrive as already-parsed JS values; the string
    // path covers legacy mock-DB shims that don't parse for us.
    const raw =
      typeof row.step_progress_json === 'string'
        ? JSON.parse(row.step_progress_json)
        : row.step_progress_json;
    if (Array.isArray(raw)) stepProgress = raw as StepProgressEntry[];
  }
  const state: CheckRunTrackingState = {
    stepProgress,
    updatedAt: row.updated_at,
  };
  if (row.check_run_id != null) {
    state.checkRunId =
      typeof row.check_run_id === 'string' ? Number(row.check_run_id) : row.check_run_id;
  }
  if (row.build_creation_state === 'pending' || row.build_creation_state === 'completed') {
    state.buildCreationState = row.build_creation_state;
  }
  if (row.in_progress_sent_at != null) {
    state.inProgressSentAt = row.in_progress_sent_at;
  }
  if (row.terminal_sent_at != null) {
    state.terminalSentAt = row.terminal_sent_at;
  }
  if (row.run_id != null) {
    state.runId = row.run_id;
  }
  return state;
}
