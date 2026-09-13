/**
 * Variable store -- context variable CRUD with lock enforcement.
 *
 * Manages org-level context variables and per-source overrides.
 * Lock enforcement: locked org vars cannot be overridden by source overrides.
 */
import { sql, type Kysely } from 'kysely';
import type { Database, ContextVariable, ContextSourceOverride } from '../db/types.js';

/**
 * Data access layer for context variables and source overrides.
 */
export class VariableStore {
  constructor(private readonly db: Kysely<Database>) {}

  // ── Org-level variables ─────────────────────────────────────────

  /** List all org-level variables for a context. */
  async listVars(orgId: string, contextId: string): Promise<ContextVariable[]> {
    return this.db
      .selectFrom('context_variables')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('context_id', '=', contextId)
      .execute();
  }

  /** Upsert an org-level variable. */
  async setVar(
    orgId: string,
    contextId: string,
    key: string,
    value: string,
    locked?: boolean,
  ): Promise<void> {
    await this.db
      .insertInto('context_variables')
      .values({
        org_id: orgId,
        context_id: contextId,
        key,
        value,
        locked: locked ?? false,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'context_id', 'key']).doUpdateSet({
          value,
          locked: locked ?? false,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Delete an org-level variable. */
  async deleteVar(orgId: string, contextId: string, key: string): Promise<void> {
    await this.db
      .deleteFrom('context_variables')
      .where('org_id', '=', orgId)
      .where('context_id', '=', contextId)
      .where('key', '=', key)
      .execute();
  }

  // ── Source overrides ────────────────────────────────────────────

  /** List source overrides for a specific source (routing key). */
  async listSourceOverrides(
    orgId: string,
    contextId: string,
    routingKey: string,
  ): Promise<ContextSourceOverride[]> {
    return this.db
      .selectFrom('context_source_overrides')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('context_id', '=', contextId)
      .where('routing_key', '=', routingKey)
      .execute();
  }

  /** Upsert a source override. */
  async setSourceOverride(
    orgId: string,
    contextId: string,
    routingKey: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.db
      .insertInto('context_source_overrides')
      .values({
        org_id: orgId,
        context_id: contextId,
        routing_key: routingKey,
        key,
        value,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'context_id', 'routing_key', 'key']).doUpdateSet({
          value,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Delete a source override. */
  async deleteSourceOverride(
    orgId: string,
    contextId: string,
    routingKey: string,
    key: string,
  ): Promise<void> {
    await this.db
      .deleteFrom('context_source_overrides')
      .where('org_id', '=', orgId)
      .where('context_id', '=', contextId)
      .where('routing_key', '=', routingKey)
      .where('key', '=', key)
      .execute();
  }

  // ── Resolved variables ──────────────────────────────────────────

  /**
   * Get resolved variables for a context, optionally merged with source overrides.
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
    contextId: string,
    routingKey?: string,
  ): Promise<Record<string, string>> {
    const orgVars = await this.listVars(orgId, contextId);

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
      const overrides = await this.listSourceOverrides(orgId, contextId, routingKey);
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
