/**
 * Context store -- CRUD operations for deployment contexts.
 *
 * Contexts are org-level entities with protection rules, scoped secrets,
 * and variable overrides. Supports fixed contexts and glob-pattern-based
 * dynamic contexts.
 */
import picomatch from 'picomatch';
import { sql, type Kysely } from 'kysely';
import { DEFAULT_CONCURRENCY_STRATEGY, DEFAULT_HOLD_EXPIRY_SECONDS } from '@kici-dev/engine';
import type { ConcurrencyStrategy, Context as EngineContext } from '@kici-dev/engine';
import type { Database, Context, NewContext } from '../db/types.js';
import { HeldRunStatus } from './held-runs.js';
import { compareGlobSpecificity } from './glob-specificity.js';

/** Thrown by `delete` when pending held runs reference the context. */
export class ContextDeleteBlockedError extends Error {
  constructor(public readonly pendingCount: number) {
    super(`Context has ${pendingCount} pending held run(s) — approve or reject them first`);
    this.name = 'ContextDeleteBlockedError';
  }
}

/** Parse a JSON string to an array, returning a fallback on failure. */
function parseJsonArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Parse a JSON string to an array or null, returning null on failure. */
function parseJsonArrayOrNull(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Map a DB context row (snake_case) to the engine Context type (camelCase).
 *
 * Kysely returns JSONB columns as strings; this function parses them into arrays.
 */
export function toContext(row: Context): EngineContext {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    type: row.type as EngineContext['type'],
    globPattern: row.glob_pattern,
    branchRestrictions: parseJsonArray(row.branch_restrictions),
    triggerTypeFilters: parseJsonArray(row.trigger_type_filters),
    repoPatterns: parseJsonArray(row.repo_patterns),
    concurrencyLimit: row.concurrency_limit,
    // Both columns are nullable and a cleared value means "unset", so they are
    // resolved here rather than handed to the gates as null — the gates take
    // non-nullable values. The strategy resolves to `DEFAULT_CONCURRENCY_STRATEGY`
    // (which is also the column's own default); the hold window to
    // `DEFAULT_HOLD_EXPIRY_SECONDS`.
    concurrencyStrategy: (row.concurrency_strategy ??
      DEFAULT_CONCURRENCY_STRATEGY) as EngineContext['concurrencyStrategy'],
    concurrencyTimeoutMs: row.concurrency_timeout_ms,
    requiredReviewers: parseJsonArrayOrNull(row.required_reviewers),
    waitTimerSeconds: row.wait_timer_seconds,
    holdExpirySeconds: row.hold_expiry_seconds ?? DEFAULT_HOLD_EXPIRY_SECONDS,
    minimumTrust: (row.minimum_trust as EngineContext['minimumTrust']) ?? undefined,
    allowLocalExecution: row.allow_local_execution,
    enabled: row.enabled,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    createdBy: row.created_by ?? '',
  };
}

/** Fields accepted when creating a context. */
export interface ContextCreateInput {
  name: string;
  type?: 'fixed' | 'glob';
  globPattern?: string | null;
  branchRestrictions?: string[];
  triggerTypeFilters?: string[];
  repoPatterns?: string[];
  concurrencyLimit?: number | null;
  concurrencyStrategy?: ConcurrencyStrategy;
  concurrencyTimeoutMs?: number;
  requiredReviewers?: string[] | null;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number;
  minimumTrust?: 'known' | 'trusted' | null;
  allowLocalExecution?: boolean;
  enabled?: boolean;
  createdBy?: string | null;
}

/**
 * Fields accepted when updating a context.
 *
 * Convention for every nullable column: `undefined` means "the caller did not
 * mention this field, leave the column alone"; `null` means "clear it". The two
 * are distinct on the wire (`contextUpdateRequestSchema` declares these fields
 * `.nullable().optional()`), so the handler forwards both verbatim and `update`
 * below writes the column's cleared state for an explicit `null` — SQL NULL for
 * the nullable columns, and the empty array for `branchRestrictions`, whose
 * column is `jsonb NOT NULL DEFAULT '[]'`.
 */
export interface ContextUpdateInput {
  name?: string;
  type?: 'fixed' | 'glob';
  globPattern?: string | null;
  branchRestrictions?: string[] | null;
  triggerTypeFilters?: string[];
  repoPatterns?: string[];
  concurrencyLimit?: number | null;
  concurrencyStrategy?: ConcurrencyStrategy | null;
  concurrencyTimeoutMs?: number;
  requiredReviewers?: string[] | null;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number | null;
  minimumTrust?: 'known' | 'trusted' | null;
  allowLocalExecution?: boolean;
  enabled?: boolean;
}

/**
 * Data access layer for contexts.
 */
export class ContextStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** List all contexts for an org, ordered by name. */
  async list(orgId: string): Promise<Context[]> {
    return this.db
      .selectFrom('contexts')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('name', 'asc')
      .execute();
  }

  /** Get a single context by org + id. Returns null if not found. */
  async get(orgId: string, id: string): Promise<Context | null> {
    const row = await this.db
      .selectFrom('contexts')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Get a single context by org + name. Returns null if not found. */
  async getByName(orgId: string, name: string): Promise<Context | null> {
    const row = await this.db
      .selectFrom('contexts')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Create a new context. Returns the created row. */
  async create(orgId: string, data: ContextCreateInput): Promise<Context> {
    const values: NewContext = {
      org_id: orgId,
      name: data.name,
      type: data.type ?? 'fixed',
      glob_pattern: data.globPattern ?? null,
      branch_restrictions: data.branchRestrictions
        ? JSON.stringify(data.branchRestrictions)
        : undefined,
      trigger_type_filters: data.triggerTypeFilters
        ? JSON.stringify(data.triggerTypeFilters)
        : undefined,
      repo_patterns: data.repoPatterns ? JSON.stringify(data.repoPatterns) : undefined,
      concurrency_limit: data.concurrencyLimit ?? null,
      concurrency_strategy: data.concurrencyStrategy,
      concurrency_timeout_ms: data.concurrencyTimeoutMs,
      required_reviewers: data.requiredReviewers
        ? JSON.stringify(data.requiredReviewers)
        : undefined,
      wait_timer_seconds: data.waitTimerSeconds ?? null,
      hold_expiry_seconds: data.holdExpirySeconds,
      minimum_trust: data.minimumTrust ?? null,
      allow_local_execution: data.allowLocalExecution,
      enabled: data.enabled,
      created_by: data.createdBy ?? null,
    };

    return this.db.insertInto('contexts').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** Update a context. Returns the updated row, or null if not found. */
  async update(orgId: string, id: string, updates: ContextUpdateInput): Promise<Context | null> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };

    if (updates.name !== undefined) set.name = updates.name;
    if (updates.type !== undefined) set.type = updates.type;
    if (updates.globPattern !== undefined) set.glob_pattern = updates.globPattern;
    if (updates.branchRestrictions !== undefined)
      // Cleared means "no restrictions", which for this column is the empty
      // array — it is `jsonb NOT NULL DEFAULT '[]'`, so a SQL NULL is rejected
      // outright and would abort the whole update. Going through
      // `JSON.stringify` on the coalesced value also keeps the four-character
      // string "null" (what `JSON.stringify(null)` yields) out of the column.
      set.branch_restrictions = JSON.stringify(updates.branchRestrictions ?? []);
    if (updates.triggerTypeFilters !== undefined)
      set.trigger_type_filters = JSON.stringify(updates.triggerTypeFilters);
    if (updates.repoPatterns !== undefined)
      set.repo_patterns = JSON.stringify(updates.repoPatterns);
    if (updates.concurrencyLimit !== undefined) set.concurrency_limit = updates.concurrencyLimit;
    if (updates.concurrencyStrategy !== undefined)
      set.concurrency_strategy = updates.concurrencyStrategy;
    if (updates.concurrencyTimeoutMs !== undefined)
      set.concurrency_timeout_ms = updates.concurrencyTimeoutMs;
    if (updates.requiredReviewers !== undefined)
      set.required_reviewers = updates.requiredReviewers
        ? JSON.stringify(updates.requiredReviewers)
        : null;
    if (updates.waitTimerSeconds !== undefined) set.wait_timer_seconds = updates.waitTimerSeconds;
    if (updates.holdExpirySeconds !== undefined)
      set.hold_expiry_seconds = updates.holdExpirySeconds;
    if (updates.minimumTrust !== undefined) set.minimum_trust = updates.minimumTrust;
    if (updates.allowLocalExecution !== undefined)
      set.allow_local_execution = updates.allowLocalExecution;
    if (updates.enabled !== undefined) set.enabled = updates.enabled;

    const row = await this.db
      .updateTable('contexts')
      .set(set)
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row ?? null;
  }

  /**
   * Delete a context.
   *
   * Bindings, variables, and source overrides cascade away via their FK.
   * Terminal held-run history survives with a null `context_id` (the FK
   * uses ON DELETE SET NULL). Pending held runs still reference the
   * context, so deletion is blocked with `ContextDeleteBlockedError`
   * until they are approved or rejected.
   */
  async delete(orgId: string, id: string): Promise<boolean> {
    // Best-effort guard: the count and the delete are separate statements, so a
    // hold created in between is nulled by the FK rather than blocking. The DB
    // no longer rejects the delete for pending rows — this check is the gate.
    const pending = await this.db
      .selectFrom('held_runs')
      .select(this.db.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .where('context_id', '=', id)
      .where('status', '=', HeldRunStatus.Pending)
      .executeTakeFirst();
    const pendingCount = Number(pending?.count ?? 0);
    if (pendingCount > 0) throw new ContextDeleteBlockedError(pendingCount);

    const result = await this.db
      .deleteFrom('contexts')
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Match a context name against org contexts.
   *
   * First tries exact name match (for fixed contexts).
   * If no exact match, scans glob-type contexts and uses picomatch. When the
   * name matches more than one glob pattern, the most-specific pattern wins
   * (most literal characters; ties break toward fewer wildcards, then name
   * ascending) so the winning context — and its protection rules — is
   * deterministic across dispatches. Returns the matching context or null.
   */
  async matchContext(orgId: string, name: string): Promise<Context | null> {
    // Try exact match first
    const exact = await this.getByName(orgId, name);
    if (exact) return exact;

    // Scan glob-type contexts (don't filter by enabled — let protection pipeline
    // handle it consistently with exact match, so disabled glob envs get a proper
    // "disabled" rejection instead of silently bypassing protection). Order by
    // name for a stable input; the specificity ranking below is authoritative.
    const globEnvs = await this.db
      .selectFrom('contexts')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('type', '=', 'glob')
      .orderBy('name', 'asc')
      .execute();

    // Collect every glob whose pattern matches, then pick the most specific so
    // the winner is deterministic when an env name matches multiple globs.
    const matches = globEnvs.filter(
      (env) => env.glob_pattern && picomatch.isMatch(name, env.glob_pattern),
    );
    if (matches.length === 0) return null;

    matches.sort((a, b) =>
      compareGlobSpecificity(
        { pattern: a.glob_pattern as string, name: a.name },
        { pattern: b.glob_pattern as string, name: b.name },
      ),
    );
    return matches[0];
  }
}
