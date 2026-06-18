/**
 * Binding store -- scope-to-environment binding CRUD.
 *
 * Bindings map scope patterns (e.g. 'aws/prod/**') to environments,
 * controlling which scoped secrets are available in each environment.
 */
import type { Kysely } from 'kysely';
import type { Database, EnvironmentBinding } from '../db/types.js';

/**
 * Data access layer for environment bindings.
 */
export class BindingStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** List all bindings for an environment. */
  async list(orgId: string, environmentId: string): Promise<EnvironmentBinding[]> {
    return this.db
      .selectFrom('environment_bindings')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('environment_id', '=', environmentId)
      .execute();
  }

  /**
   * Replace all bindings for an environment in a transaction.
   *
   * Deletes existing bindings and inserts the new set atomically.
   * Pass an empty array to clear all bindings.
   */
  async set(orgId: string, environmentId: string, scopePatterns: string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Delete existing bindings
      await trx
        .deleteFrom('environment_bindings')
        .where('org_id', '=', orgId)
        .where('environment_id', '=', environmentId)
        .execute();

      // Insert new bindings (deduplicate to avoid unique constraint violation)
      const uniquePatterns = [...new Set(scopePatterns)];
      if (uniquePatterns.length > 0) {
        const values = uniquePatterns.map((pattern) => ({
          org_id: orgId,
          environment_id: environmentId,
          scope_pattern: pattern,
        }));

        await trx.insertInto('environment_bindings').values(values).execute();
      }
    });
  }

  /** Find bindings for an environment (alias for list, used by secret resolver). */
  async findBindingsForEnvironment(
    orgId: string,
    environmentId: string,
  ): Promise<EnvironmentBinding[]> {
    return this.list(orgId, environmentId);
  }
}
