/**
 * Environment store -- CRUD operations for deployment environments.
 *
 * Environments are org-level entities with protection rules, scoped secrets,
 * and variable overrides. Supports fixed environments and glob-pattern-based
 * dynamic environments.
 */
import picomatch from 'picomatch';
import { sql, type Kysely } from 'kysely';
import type { Environment as EngineEnvironment } from '@kici-dev/engine';
import type { Database, Environment, NewEnvironment } from '../db/types.js';
import { HeldRunStatus } from './held-runs.js';

/** Thrown by `delete` when pending held runs reference the environment. */
export class EnvironmentDeleteBlockedError extends Error {
  constructor(public readonly pendingCount: number) {
    super(`Environment has ${pendingCount} pending held run(s) — approve or reject them first`);
    this.name = 'EnvironmentDeleteBlockedError';
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
 * Map a DB environment row (snake_case) to the engine Environment type (camelCase).
 *
 * Kysely returns JSONB columns as strings; this function parses them into arrays.
 */
export function toEnvironment(row: Environment): EngineEnvironment {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    type: row.type as EngineEnvironment['type'],
    globPattern: row.glob_pattern,
    branchRestrictions: parseJsonArray(row.branch_restrictions),
    triggerTypeFilters: parseJsonArray(row.trigger_type_filters),
    repoPatterns: parseJsonArray(row.repo_patterns),
    concurrencyLimit: row.concurrency_limit,
    concurrencyStrategy: row.concurrency_strategy as EngineEnvironment['concurrencyStrategy'],
    concurrencyTimeoutMs: row.concurrency_timeout_ms,
    requiredReviewers: parseJsonArrayOrNull(row.required_reviewers),
    waitTimerSeconds: row.wait_timer_seconds,
    holdExpirySeconds: row.hold_expiry_seconds,
    minimumTrust: (row.minimum_trust as EngineEnvironment['minimumTrust']) ?? undefined,
    allowLocalExecution: row.allow_local_execution,
    enabled: row.enabled,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    createdBy: row.created_by ?? '',
  };
}

/** Fields accepted when creating an environment. */
export interface EnvironmentCreateInput {
  name: string;
  type?: 'fixed' | 'glob';
  globPattern?: string | null;
  branchRestrictions?: string[];
  triggerTypeFilters?: string[];
  repoPatterns?: string[];
  concurrencyLimit?: number | null;
  concurrencyStrategy?: 'queue' | 'cancel-pending';
  concurrencyTimeoutMs?: number;
  requiredReviewers?: string[] | null;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number;
  minimumTrust?: 'known' | 'trusted' | null;
  allowLocalExecution?: boolean;
  enabled?: boolean;
  createdBy?: string | null;
}

/** Fields accepted when updating an environment. */
export interface EnvironmentUpdateInput {
  name?: string;
  type?: 'fixed' | 'glob';
  globPattern?: string | null;
  branchRestrictions?: string[];
  triggerTypeFilters?: string[];
  repoPatterns?: string[];
  concurrencyLimit?: number | null;
  concurrencyStrategy?: 'queue' | 'cancel-pending';
  concurrencyTimeoutMs?: number;
  requiredReviewers?: string[] | null;
  waitTimerSeconds?: number | null;
  holdExpirySeconds?: number;
  minimumTrust?: 'known' | 'trusted' | null;
  allowLocalExecution?: boolean;
  enabled?: boolean;
}

/**
 * Data access layer for environments.
 */
export class EnvironmentStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** List all environments for an org, ordered by name. */
  async list(orgId: string): Promise<Environment[]> {
    return this.db
      .selectFrom('environments')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('name', 'asc')
      .execute();
  }

  /** Get a single environment by org + id. Returns null if not found. */
  async get(orgId: string, id: string): Promise<Environment | null> {
    const row = await this.db
      .selectFrom('environments')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Get a single environment by org + name. Returns null if not found. */
  async getByName(orgId: string, name: string): Promise<Environment | null> {
    const row = await this.db
      .selectFrom('environments')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Create a new environment. Returns the created row. */
  async create(orgId: string, data: EnvironmentCreateInput): Promise<Environment> {
    const values: NewEnvironment = {
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

    return this.db
      .insertInto('environments')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Update an environment. Returns the updated row, or null if not found. */
  async update(
    orgId: string,
    id: string,
    updates: EnvironmentUpdateInput,
  ): Promise<Environment | null> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };

    if (updates.name !== undefined) set.name = updates.name;
    if (updates.type !== undefined) set.type = updates.type;
    if (updates.globPattern !== undefined) set.glob_pattern = updates.globPattern;
    if (updates.branchRestrictions !== undefined)
      set.branch_restrictions = JSON.stringify(updates.branchRestrictions);
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
      .updateTable('environments')
      .set(set)
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row ?? null;
  }

  /**
   * Delete an environment.
   *
   * Bindings, variables, and source overrides cascade away via their FK.
   * Terminal held-run history survives with a null `environment_id` (the FK
   * uses ON DELETE SET NULL). Pending held runs still reference the
   * environment, so deletion is blocked with `EnvironmentDeleteBlockedError`
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
      .where('environment_id', '=', id)
      .where('status', '=', HeldRunStatus.Pending)
      .executeTakeFirst();
    const pendingCount = Number(pending?.count ?? 0);
    if (pendingCount > 0) throw new EnvironmentDeleteBlockedError(pendingCount);

    const result = await this.db
      .deleteFrom('environments')
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Match an environment name against org environments.
   *
   * First tries exact name match (for fixed environments).
   * If no exact match, scans glob-type environments and uses picomatch.
   * Returns the first matching environment or null.
   */
  async matchEnvironment(orgId: string, name: string): Promise<Environment | null> {
    // Try exact match first
    const exact = await this.getByName(orgId, name);
    if (exact) return exact;

    // Scan glob-type environments (don't filter by enabled — let protection pipeline
    // handle it consistently with exact match, so disabled glob envs get a proper
    // "disabled" rejection instead of silently bypassing protection)
    const globEnvs = await this.db
      .selectFrom('environments')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('type', '=', 'glob')
      .execute();

    for (const env of globEnvs) {
      if (env.glob_pattern && picomatch.isMatch(name, env.glob_pattern)) {
        return env;
      }
    }

    return null;
  }
}
