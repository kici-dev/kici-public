import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types.js';
import type { StepProgressEntry } from './check-run-summary.js';

/**
 * Composite key identifying a single check-run row.
 *
 * Matches the table primary key `(provider, owner, repo, sha, check_name)`.
 * Used by the L1 in-memory cache and as the parameter shape for every
 * store method.
 */
export interface CheckRunTrackingKey {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  checkName: string;
}

/**
 * Snapshot of all per-key check-run state. Mirrors the columns of the
 * `check_run_tracking` table with the in-memory shapes the consumer
 * already uses.
 */
export interface CheckRunTrackingState {
  /** GitHub Checks API check-run ID. Undefined when not yet created. */
  checkRunId?: number;
  /** Build check-run lifecycle marker. */
  buildCreationState?: 'pending' | 'completed';
  /** Live step-progress entries shown in the check run's `output.summary`. */
  stepProgress: StepProgressEntry[];
  /** Timestamp the first running-step transition was sent to GitHub. */
  inProgressSentAt?: Date;
  /** KiCI run this check-run belongs to. Used by `cleanupRun`. */
  runId?: string;
  /** Last persisted update time; powers debounce-after-failover recovery. */
  updatedAt?: Date;
}

/**
 * DB persistence for `CheckRunReporter` check-run state.
 *
 * Backed by the `check_run_tracking` table — one row per
 * `(provider, owner, repo, sha, check_name)`. Replaces six in-memory
 * `Map`s previously held inside `CheckRunReporter`:
 *
 *   - `checkRunIds`            → `check_run_id` column
 *   - `pendingBuildCreations`  → `build_creation_state` column
 *   - `stepProgress`           → `step_progress_json` column
 *   - `inProgressSent`         → `in_progress_sent_at` column
 *   - `runIdToKeys`            → indexed `run_id` column + `listKeysByRunId`
 *
 * The `progressTimers` Map is intentionally NOT persisted — debounce
 * timers are reconstructed on demand. After a coord failover the very
 * next `updateStepProgress` either flushes immediately (debounce window
 * elapsed) or starts a fresh timer.
 *
 * The consumer keeps an L1 in-memory cache in front of this store; the
 * store itself is stateless beyond the connection it holds.
 */
export class CheckRunTrackingStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Atomically set / overwrite the check-run ID for a key.
   *
   * Performed as an upsert so a re-issued setPending after a coord
   * failover replaces the prior ID rather than silently leaving a row
   * mismatched with the GitHub-side state.
   */
  async setCheckRunId(key: CheckRunTrackingKey, checkRunId: number): Promise<void> {
    await this.upsertRow(key, { check_run_id: checkRunId });
  }

  /**
   * Lookup the check-run ID for a key. Returns undefined if no row exists
   * yet OR the row exists but the GitHub create has not finished
   * persisting an ID (the build-creation in-flight window).
   */
  async getCheckRunId(key: CheckRunTrackingKey): Promise<number | undefined> {
    const row = await this.selectRow(key);
    if (!row) return undefined;
    if (row.check_run_id == null) return undefined;
    // Postgres BIGINT lands as a string when going through pg; coerce defensively.
    return typeof row.check_run_id === 'string' ? Number(row.check_run_id) : row.check_run_id;
  }

  /**
   * Mark a build check-run as having an in-flight create. Returns true if
   * this caller won the race (no prior row, or row had no in-flight state).
   * Used to prevent a replacement coord from re-issuing a `checks.create()`
   * against the same SHA when the original create is still pending.
   */
  async markBuildCreationPending(key: CheckRunTrackingKey, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      build_creation_state: 'pending',
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /**
   * Mark a build check-run create as complete. Idempotent.
   */
  async markBuildCreationComplete(key: CheckRunTrackingKey): Promise<void> {
    await this.upsertRow(key, { build_creation_state: 'completed' });
  }

  /**
   * Replace the step-progress array for a key.
   */
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

  /**
   * Mark the first in-progress transition as sent. Used to keep the
   * single "did we already kick this check run into in_progress?" guard
   * cluster-wide.
   */
  async markInProgressSent(key: CheckRunTrackingKey, runId?: string): Promise<void> {
    await this.upsertRow(key, {
      in_progress_sent_at: new Date(),
      ...(runId !== undefined && { run_id: runId }),
    });
  }

  /**
   * Get the full state snapshot for a key. Used by the L1 cache to
   * hydrate on miss and by tests to verify the on-disk layout. Returns
   * undefined when no row exists.
   */
  async getState(key: CheckRunTrackingKey): Promise<CheckRunTrackingState | undefined> {
    const row = await this.selectRow(key);
    if (!row) return undefined;
    return rowToState(row);
  }

  /**
   * Delete a single row. Returns true if the row existed.
   */
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
   * List every key currently tracked for a runId. Used by `cleanupRun`
   * to reproduce the runId → keys reverse index that the in-memory map
   * provided. Index `idx_check_run_tracking_run_id` keeps this O(matches).
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
   * Delete every row for a runId. Mirrors the bulk-cleanup semantics of
   * `cleanupRun` so a single call from execution-tracker prune releases
   * all rows for the run.
   */
  async deleteByRunId(runId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('check_run_tracking')
      .where('run_id', '=', runId)
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
          ...(updates.run_id !== undefined && { run_id: updates.run_id }),
          updated_at: sql`NOW()`,
        }),
      )
      .execute();
  }
}

/**
 * Convert a raw DB row to the in-memory `CheckRunTrackingState` shape.
 * Exported for direct use from tests that bypass the store.
 */
export function rowToState(row: {
  check_run_id: number | string | null;
  build_creation_state: string | null;
  step_progress_json: unknown;
  in_progress_sent_at: Date | null;
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
  if (row.run_id != null) {
    state.runId = row.run_id;
  }
  return state;
}
