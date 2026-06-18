/**
 * Variable store -- environment variable CRUD with lock enforcement.
 *
 * Manages org-level environment variables and per-source overrides.
 * Lock enforcement: locked org vars cannot be overridden by source overrides.
 */
import { sql, type Kysely } from 'kysely';
import type { Database, EnvironmentVariable, EnvironmentSourceOverride } from '../db/types.js';

/**
 * Data access layer for environment variables and source overrides.
 */
export class VariableStore {
  constructor(private readonly db: Kysely<Database>) {}

  // ── Org-level variables ─────────────────────────────────────────

  /** List all org-level variables for an environment. */
  async listVars(orgId: string, environmentId: string): Promise<EnvironmentVariable[]> {
    return this.db
      .selectFrom('environment_variables')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('environment_id', '=', environmentId)
      .execute();
  }

  /** Upsert an org-level variable. */
  async setVar(
    orgId: string,
    environmentId: string,
    key: string,
    value: string,
    locked?: boolean,
  ): Promise<void> {
    await this.db
      .insertInto('environment_variables')
      .values({
        org_id: orgId,
        environment_id: environmentId,
        key,
        value,
        locked: locked ?? false,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'environment_id', 'key']).doUpdateSet({
          value,
          locked: locked ?? false,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Delete an org-level variable. */
  async deleteVar(orgId: string, environmentId: string, key: string): Promise<void> {
    await this.db
      .deleteFrom('environment_variables')
      .where('org_id', '=', orgId)
      .where('environment_id', '=', environmentId)
      .where('key', '=', key)
      .execute();
  }

  // ── Source overrides ────────────────────────────────────────────

  /** List source overrides for a specific source (routing key). */
  async listSourceOverrides(
    orgId: string,
    environmentId: string,
    routingKey: string,
  ): Promise<EnvironmentSourceOverride[]> {
    return this.db
      .selectFrom('environment_source_overrides')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('environment_id', '=', environmentId)
      .where('routing_key', '=', routingKey)
      .execute();
  }

  /** Upsert a source override. */
  async setSourceOverride(
    orgId: string,
    environmentId: string,
    routingKey: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.db
      .insertInto('environment_source_overrides')
      .values({
        org_id: orgId,
        environment_id: environmentId,
        routing_key: routingKey,
        key,
        value,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'environment_id', 'routing_key', 'key']).doUpdateSet({
          value,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Delete a source override. */
  async deleteSourceOverride(
    orgId: string,
    environmentId: string,
    routingKey: string,
    key: string,
  ): Promise<void> {
    await this.db
      .deleteFrom('environment_source_overrides')
      .where('org_id', '=', orgId)
      .where('environment_id', '=', environmentId)
      .where('routing_key', '=', routingKey)
      .where('key', '=', key)
      .execute();
  }

  // ── Resolved variables ──────────────────────────────────────────

  /**
   * Get resolved variables for an environment, optionally merged with source overrides.
   *
   * Merge rules:
   * - Org-level vars form the base
   * - Source overrides can add new keys and override unlocked org vars
   * - Locked org vars are NOT overridden by source overrides
   *
   * @param routingKey - If provided, source overrides are merged in
   */
  async getResolvedVars(
    orgId: string,
    environmentId: string,
    routingKey?: string,
  ): Promise<Record<string, string>> {
    const orgVars = await this.listVars(orgId, environmentId);

    // Build base from org vars
    const result: Record<string, string> = {};
    const lockedKeys = new Set<string>();

    for (const v of orgVars) {
      result[v.key] = v.value;
      if (v.locked) {
        lockedKeys.add(v.key);
      }
    }

    // Merge source overrides if routing key provided
    if (routingKey) {
      const overrides = await this.listSourceOverrides(orgId, environmentId, routingKey);
      for (const o of overrides) {
        // Locked vars resist source overrides
        if (!lockedKeys.has(o.key)) {
          result[o.key] = o.value;
        }
      }
    }

    return result;
  }
}
