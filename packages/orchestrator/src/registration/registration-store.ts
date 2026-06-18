import type { Kysely } from 'kysely';

import type { LockWorkflow } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

import type { Database, WorkflowRegistration } from '../db/types.js';

const logger = createLogger({ prefix: 'registration-store' });

/**
 * Parsed registration row with typed fields.
 * DB stores lock_entry as JSON string and trigger_types as TEXT[],
 * but this interface exposes them as typed objects.
 */
export interface RegistrationRow {
  id: string;
  repo_identifier: string;
  workflow_name: string;
  lock_entry: LockWorkflow;
  trigger_types: string[];
  routing_key: string;
  provider_context: Record<string, unknown>;
  disabled: boolean;
  isGlobal: boolean;
  /**
   * Customer/org ID that owns this registration. Sourced from the source row
   * (sources or generic_webhook_sources joined on routing_key) and persisted
   * by replaceAll. Drives the (customer_id, eventName) lookup in
   * RegistrationIndex used by cross-source webhook delivery.
   */
  customerId: string;
  commitSha: string | null;
  sourceFile: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Options for replaceAll to pass commit tracking metadata.
 */
interface ReplaceAllOptions {
  /**
   * Customer/org ID that owns the registrations being written. REQUIRED —
   * persisted into workflow_registrations.customer_id (NOT NULL since
   * migration 020) and used by RegistrationIndex.byOrgAndEvent for
   * cross-source webhook lookup.
   */
  customerId: string;
  commitSha?: string;
  sourceFile?: string;
  /** Set of workflow names that should be marked as global */
  globalWorkflowNames?: Set<string>;
}

/**
 * DB CRUD for workflow_registrations table with atomic upsert-based replace-all.
 *
 * The replace-all pattern uses SELECT + UPDATE/INSERT + selective DELETE in a
 * single transaction. This preserves existing registration UUIDs (and their
 * cascaded cron_last_fired records) while still being atomic against concurrent
 * pushes.
 */
export class RegistrationStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Atomically replace all registrations for a repo (scoped by routing key).
   *
   * Uses an upsert pattern that preserves existing registration IDs:
   * 1. SELECT existing rows for this routing_key + repo
   * 2. UPDATE rows whose workflow_name still exists in the incoming set
   * 3. INSERT rows for new workflow_names
   * 4. DELETE rows whose workflow_name is no longer in the incoming set
   *
   * This prevents cascade deletion of cron_last_fired records when workflows
   * are re-registered on every default-branch push.
   */
  async replaceAll(
    repoIdentifier: string,
    workflows: LockWorkflow[],
    routingKey: string,
    providerContext: Record<string, unknown>,
    options: ReplaceAllOptions,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // 1. Fetch existing registrations for this repo+routing key
      const existing = await trx
        .selectFrom('workflow_registrations')
        .selectAll()
        .where('routing_key', '=', routingKey)
        .where('repo_identifier', '=', repoIdentifier)
        .execute();

      const existingByName = new Map(existing.map((r) => [r.workflow_name, r]));
      const incomingNames = new Set(workflows.map((w) => w.name));

      // Self-heal: if any existing row has customer_id='__default__' AND the
      // incoming options.customerId is a real tenant, rewrite the stale rows
      // in this same transaction. See Plan 28.6.2-07 / spike 2026-04-12.
      //
      // Why this matters: workflow_registrations rows can be created with
      // customer_id='__default__' when processor.resolveOrgId() returned the
      // sentinel because sources.customer_id was not yet populated. After
      // deploy-stg.ts:updateSourcesCustomerId() rewrites sources.customer_id,
      // those workflow_registrations rows stay stale because replaceAll()
      // only re-runs on a real push event AND historically had no back-fill.
      // The 2026-04-12 spike found 12 such rows in staging that broke
      // Plan 06's cross-provider lock-file fallback.
      //
      // We do NOT rewrite __default__ to __default__ (no heal needed, no
      // noisy log). We do NOT rewrite real-to-real (the upsert loop already
      // handles updates per workflow row).
      if (options.customerId !== '__default__') {
        const staleRows = existing.filter((r) => r.customer_id === '__default__');
        if (staleRows.length > 0) {
          await trx
            .updateTable('workflow_registrations')
            .set({ customer_id: options.customerId, updated_at: new Date() })
            .where('routing_key', '=', routingKey)
            .where('repo_identifier', '=', repoIdentifier)
            .where('customer_id', '=', '__default__')
            .execute();

          logger.info('Registration self-heal: rewrote stale customer_id', {
            routingKey,
            repoIdentifier,
            oldCustomerId: '__default__',
            newCustomerId: options.customerId,
            rowsHealed: staleRows.length,
          });

          // Patch the in-memory `existing` rows so the upsert loop below
          // sees the corrected customer_id (defensive — the loop doesn't
          // currently read customer_id, but a future change might).
          for (const row of staleRows) {
            (row as { customer_id: string }).customer_id = options.customerId;
          }
        }
      }

      const globalNames = options.globalWorkflowNames ?? new Set<string>();

      // 2. For each incoming workflow: UPDATE if exists, INSERT if new
      for (const w of workflows) {
        const isGlobal = globalNames.has(w.name);
        const row = existingByName.get(w.name);
        if (row) {
          // UPDATE existing row -- preserves the UUID and cron_last_fired FK
          // NOTE: do NOT include 'disabled' -- that would reset manually-disabled workflows
          await trx
            .updateTable('workflow_registrations')
            .set({
              lock_entry: JSON.stringify(w),
              trigger_types: [...new Set(w.triggers.map((t) => t._type))],
              provider_context: JSON.stringify(providerContext),
              commit_sha: options.commitSha ?? null,
              source_file: options.sourceFile ?? `.kici/workflows/${w.name}.ts`,
              is_global: isGlobal,
              updated_at: new Date(),
            })
            .where('id', '=', row.id)
            .execute();
        } else {
          // INSERT new workflow
          await trx
            .insertInto('workflow_registrations')
            .values({
              repo_identifier: repoIdentifier,
              workflow_name: w.name,
              lock_entry: JSON.stringify(w),
              trigger_types: [...new Set(w.triggers.map((t) => t._type))],
              routing_key: routingKey,
              provider_context: JSON.stringify(providerContext),
              customer_id: options.customerId,
              commit_sha: options.commitSha ?? null,
              source_file: options.sourceFile ?? `.kici/workflows/${w.name}.ts`,
              is_global: isGlobal,
            })
            .execute();
        }
      }

      // 3. DELETE workflows that are no longer in the incoming set
      const removedNames = [...existingByName.keys()].filter((name) => !incomingNames.has(name));
      if (removedNames.length > 0) {
        await trx
          .deleteFrom('workflow_registrations')
          .where('routing_key', '=', routingKey)
          .where('repo_identifier', '=', repoIdentifier)
          .where('workflow_name', 'in', removedNames)
          .execute();
      }
    });
  }

  /**
   * Toggle the disabled state of a workflow registration.
   * Returns true if a row was updated, false if the ID was not found.
   */
  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    const result = await this.db
      .updateTable('workflow_registrations')
      .set({ disabled, updated_at: new Date() })
      .where('id', '=', id)
      .executeTakeFirst();

    return BigInt(result.numUpdatedRows) > 0n;
  }

  /**
   * Get all registrations (for index loading on startup).
   */
  async getAll(): Promise<RegistrationRow[]> {
    const rows = await this.db.selectFrom('workflow_registrations').selectAll().execute();

    return rows.map(parseRow);
  }

  /**
   * Get registrations for a specific routing key.
   */
  async getByRoutingKey(routingKey: string): Promise<RegistrationRow[]> {
    const rows = await this.db
      .selectFrom('workflow_registrations')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .execute();

    return rows.map(parseRow);
  }

  /**
   * Get registrations for a specific routing key + repo pair.
   */
  async getByRoutingKeyAndRepo(
    routingKey: string,
    repoIdentifier: string,
  ): Promise<RegistrationRow[]> {
    const rows = await this.db
      .selectFrom('workflow_registrations')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .where('repo_identifier', '=', repoIdentifier)
      .execute();

    return rows.map(parseRow);
  }

  /**
   * Get a single registration by ID. Returns null if not found.
   */
  async getById(id: string): Promise<RegistrationRow | null> {
    const row = await this.db
      .selectFrom('workflow_registrations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? parseRow(row) : null;
  }

  /**
   * Delete a single registration by ID. Returns true if deleted.
   */
  async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('workflow_registrations')
      .where('id', '=', id)
      .executeTakeFirst();

    return BigInt(result.numDeletedRows) > 0n;
  }

  /**
   * Delete all registrations for a routing key + repo pair.
   */
  async deleteByRoutingKeyAndRepo(routingKey: string, repoIdentifier: string): Promise<void> {
    await this.db
      .deleteFrom('workflow_registrations')
      .where('routing_key', '=', routingKey)
      .where('repo_identifier', '=', repoIdentifier)
      .execute();
  }

  /**
   * Get the current registry version (for cluster sync).
   */
  async getVersion(): Promise<number> {
    const row = await this.db
      .selectFrom('registry_versions')
      .selectAll()
      .where('id', '=', 'default')
      .executeTakeFirstOrThrow();

    return row.version;
  }

  /**
   * Increment the registry version and return the new value.
   * Called after registration changes to notify peers via heartbeat.
   */
  async bumpVersion(): Promise<number> {
    const row = await this.db
      .updateTable('registry_versions')
      .set((eb) => ({
        version: eb('version', '+', 1),
        updated_at: new Date(),
      }))
      .where('id', '=', 'default')
      .returningAll()
      .executeTakeFirstOrThrow();

    return row.version;
  }
}

/**
 * Parse a DB row into a typed RegistrationRow.
 * Handles JSON parsing of lock_entry.
 */
function parseRow(row: WorkflowRegistration): RegistrationRow {
  // lock_entry is jsonb — Kysely may return it as already-parsed object or as string
  const lockEntry =
    typeof row.lock_entry === 'string'
      ? (JSON.parse(row.lock_entry) as LockWorkflow)
      : (row.lock_entry as unknown as LockWorkflow);

  // provider_context is jsonb — Kysely may return as already-parsed or string
  const providerContext =
    typeof row.provider_context === 'string'
      ? (JSON.parse(row.provider_context) as Record<string, unknown>)
      : ((row.provider_context as unknown as Record<string, unknown>) ?? {});

  return {
    id: row.id,
    repo_identifier: row.repo_identifier,
    workflow_name: row.workflow_name,
    lock_entry: lockEntry,
    trigger_types: row.trigger_types,
    routing_key: row.routing_key,
    provider_context: providerContext,
    disabled: row.disabled ?? false,
    isGlobal: row.is_global ?? false,
    customerId: row.customer_id,
    commitSha: row.commit_sha ?? null,
    sourceFile: row.source_file ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
