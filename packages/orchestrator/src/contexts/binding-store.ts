/**
 * Binding store -- scope-to-context binding CRUD.
 *
 * Bindings map scope patterns (e.g. 'aws/prod/**') to contexts,
 * controlling which scoped secrets are available in each context.
 */
import type { Kysely } from 'kysely';
import type { Database, ContextBinding } from '../db/types.js';

/**
 * A scope→context binding with its host selector. `hostPattern` defaults to
 * `'**'` (all hosts) when omitted.
 */
export interface BindingInput {
  scopePattern: string;
  hostPattern?: string;
}

/**
 * Data access layer for context bindings.
 */
export class BindingStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** List all bindings for an context. */
  async list(orgId: string, contextId: string): Promise<ContextBinding[]> {
    return this.db
      .selectFrom('context_bindings')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('context_id', '=', contextId)
      .execute();
  }

  /**
   * Replace all bindings for an context in a transaction.
   *
   * Deletes existing bindings and inserts the new set atomically. Each binding
   * carries a `scopePattern` and an optional `hostPattern` (defaulting to
   * `'**'`). Pass an empty array to clear all bindings.
   */
  async set(orgId: string, contextId: string, bindings: BindingInput[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('context_bindings')
        .where('org_id', '=', orgId)
        .where('context_id', '=', contextId)
        .execute();

      // Deduplicate by (scopePattern, hostPattern) to avoid unique violations.
      const seen = new Set<string>();
      const values: Array<{
        org_id: string;
        context_id: string;
        scope_pattern: string;
        host_pattern: string;
      }> = [];
      for (const b of bindings) {
        const hostPattern = b.hostPattern ?? '**';
        const dedupKey = `${b.scopePattern}\u0000${hostPattern}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        values.push({
          org_id: orgId,
          context_id: contextId,
          scope_pattern: b.scopePattern,
          host_pattern: hostPattern,
        });
      }

      if (values.length > 0) {
        await trx.insertInto('context_bindings').values(values).execute();
      }
    });
  }

  /** Find bindings for an context (alias for list, used by secret resolver). */
  async findBindingsForContext(orgId: string, contextId: string): Promise<ContextBinding[]> {
    return this.list(orgId, contextId);
  }
}
