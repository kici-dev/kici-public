/**
 * Generic webhook source manager.
 *
 * Provides CRUD operations for webhook source configurations stored in
 * the generic_webhook_sources table. Each source defines verification method,
 * event type extraction rules, rate limits, and header filtering.
 */

import { type Kysely, sql } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database, GenericWebhookSource, NewGenericWebhookSource } from '../db/types.js';
import type { VerificationMethod } from '../providers/generic/verification.js';
import {
  UniversalGitConfigSchema,
  presetWebhookEventHeader,
  type UniversalGitConfig,
} from '../providers/universal-git/config.js';
import {
  LocalSourceConfigSchema,
  type LocalSourceConfig,
} from '../providers/local/local-source-config.js';

const logger = createLogger({ prefix: 'generic-sources' });

/**
 * Input for creating a new generic webhook source.
 */
interface CreateSourceInput {
  orgId: string;
  name: string;
  verificationMethod?: VerificationMethod;
  verificationConfig?: Record<string, unknown>;
  eventTypeHeader?: string;
  eventTypePath?: string;
  idempotencyKeyHeader?: string;
  idempotencyKeyPath?: string;
  dedupWindowSeconds?: number;
  maxPayloadBytes?: number;
  allowedEvents?: string[];
  stripHeaders?: string[];
  rateLimitRpm?: number;
  /** Provider implementation: 'generic' (default) or 'local' (a git repo on
   *  the agent filesystem cloned via file://, routed through
   *  LocalWebhookNormalizer). */
  providerType?: 'generic' | 'local';
  /** Universal-git configuration — when set, promotes this source from a
   *  payload-only generic webhook to a full git-aware source that can register
   *  workflows, fetch lock files, and be cloned by agents. Validated against
   *  `UniversalGitConfigSchema`; stored as JSONB in `generic_webhook_sources.git_config`. */
  gitConfig?: UniversalGitConfig;
  /** Local filesystem source config (`{ repoBasePath, cloneUrlBase? }`).
   *  Mutually exclusive with `gitConfig`. Stored as JSONB in the same
   *  `git_config` column, discriminated from universal-git by `providerType='local'`.
   *  Validated against `LocalSourceConfigSchema`. */
  localConfig?: LocalSourceConfig;
}

/**
 * Input for updating an existing generic webhook source. Use `gitConfig: null`
 * to explicitly demote a universal-git source back to a plain generic webhook
 * (omitting the field leaves the existing config untouched).
 */
type UpdateSourceInput = Partial<Omit<CreateSourceInput, 'orgId' | 'gitConfig' | 'localConfig'>> & {
  gitConfig?: UniversalGitConfig | null;
  /** `null` clears the local config; a validated object re-serializes it to
   *  `git_config`. Omit to leave the existing config untouched. */
  localConfig?: LocalSourceConfig | null;
};

/**
 * Generic webhook source manager.
 *
 * Manages CRUD operations for generic_webhook_sources table.
 * Sources are identified by routing keys with format `generic:<orgId>:<sourceId>`.
 */
export class GenericSourceManager {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a new generic webhook source.
   * Generates a routing key in format `generic:<orgId>:<sourceId>`.
   */
  async create(input: CreateSourceInput): Promise<GenericWebhookSource> {
    const id = crypto.randomUUID();
    const routingKey = `generic:${input.orgId}:${id}`;

    // Validate the git_config payload (Zod) before any DB write so we fail fast
    // on bad input rather than returning a half-created row. The `git_config`
    // column is dual-purpose: it holds universal-git config OR local-source
    // config, discriminated by `provider_type`.
    const validatedGitConfig = input.gitConfig
      ? UniversalGitConfigSchema.parse(input.gitConfig)
      : undefined;
    const validatedLocalConfig = input.localConfig
      ? LocalSourceConfigSchema.parse(input.localConfig)
      : undefined;
    const gitConfigJson = validatedGitConfig
      ? JSON.stringify(validatedGitConfig)
      : validatedLocalConfig
        ? JSON.stringify(validatedLocalConfig)
        : null;

    // For universal-git sources, default the row's `event_type_header` to
    // the preset's canonical webhook header (e.g. `X-Gitea-Event` for
    // forgejo/gitea, `X-Gitlab-Event` for gitlab-repo). The generic webhook
    // ingester reads this header to classify the event before passing it to
    // the universal-git normalizer; without the preset-aware default, every
    // forge except plain GitHub would fall through to event=`default`.
    const presetHeader = validatedGitConfig
      ? presetWebhookEventHeader(validatedGitConfig.preset)
      : null;
    const resolvedEventTypeHeader = input.eventTypeHeader ?? presetHeader ?? null;

    const row: NewGenericWebhookSource = {
      id,
      customer_id: input.orgId,
      name: input.name,
      routing_key: routingKey,
      verification_method: input.verificationMethod ?? 'hmac_sha256',
      verification_config: JSON.stringify(input.verificationConfig ?? {}),
      event_type_header: resolvedEventTypeHeader,
      event_type_path: input.eventTypePath ?? null,
      idempotency_key_header: input.idempotencyKeyHeader ?? null,
      idempotency_key_path: input.idempotencyKeyPath ?? null,
      dedup_window_seconds: input.dedupWindowSeconds ?? 300,
      max_payload_bytes: input.maxPayloadBytes ?? 1048576,
      allowed_events: input.allowedEvents ? JSON.stringify(input.allowedEvents) : null,
      strip_headers: JSON.stringify(
        input.stripHeaders ?? [
          'authorization',
          'cookie',
          'set-cookie',
          'proxy-authorization',
          'x-api-key',
          'x-auth-token',
        ],
      ),
      rate_limit_rpm: input.rateLimitRpm ?? 600,
      enabled: true,
      deleted_at: null,
      provider_type: input.providerType ?? 'generic',
      git_config: gitConfigJson,
    };

    const result = await this.db
      .insertInto('generic_webhook_sources')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    logger.info('Generic webhook source created', {
      id: result.id,
      orgId: input.orgId,
      name: input.name,
      routingKey,
    });

    return result;
  }

  /**
   * Get a source by ID (excludes soft-deleted sources).
   */
  async getById(id: string): Promise<GenericWebhookSource | null> {
    const result = await this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return result ?? null;
  }

  /**
   * Get a source by routing key (excludes soft-deleted and disabled sources).
   */
  async getByRoutingKey(routingKey: string): Promise<GenericWebhookSource | null> {
    const result = await this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .where('deleted_at', 'is', null)
      .where('enabled', '=', true)
      .executeTakeFirst();

    return result ?? null;
  }

  /**
   * Get a source by org ID and name (unique lookup, excludes soft-deleted).
   */
  async getByOrgAndName(orgId: string, name: string): Promise<GenericWebhookSource | null> {
    const result = await this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('customer_id', '=', orgId)
      .where('name', '=', name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return result ?? null;
  }

  /**
   * List all sources for an org.
   */
  async list(orgId: string, includeDeleted = false): Promise<GenericWebhookSource[]> {
    let query = this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('customer_id', '=', orgId);

    if (!includeDeleted) {
      query = query.where('deleted_at', 'is', null);
    }

    return query.orderBy('created_at', 'asc').execute();
  }

  /**
   * List all enabled, non-deleted sources matching a provider type.
   *
   * Used at orchestrator startup to register provider bundles per routing key
   * (e.g. registering a LocalWebhookNormalizer bundle for every
   * provider_type='local' source so local filesystem repos can dispatch real
   * runs through the generic endpoint without a real GitHub signature).
   */
  async listByProviderType(providerType: 'generic' | 'local'): Promise<GenericWebhookSource[]> {
    return this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('provider_type', '=', providerType)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /**
   * List all enabled, non-deleted sources with a non-null `git_config`
   * (universal-git sources). Used at orchestrator startup + config reload
   * to register a universal-git `ProviderBundle` under each source's
   * routing key.
   *
   * Local sources ALSO carry `git_config` (they store `{ repoBasePath }` there),
   * so this query MUST exclude `provider_type='local'` — otherwise a local
   * source would be mis-registered as a universal-git bundle. The matching
   * discrimination lives in `genericProviderTypeToSubtype` (local branch first)
   * and `registerProviderBundleForSource` (local branch before the universal-git
   * branch).
   */
  async listUniversalGitSources(): Promise<GenericWebhookSource[]> {
    return this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('git_config', 'is not', null)
      .where('provider_type', '!=', 'local')
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /**
   * List all enabled, non-deleted local filesystem sources
   * (`provider_type='local'`). Used at orchestrator startup + config reload to
   * register a `LocalWebhookNormalizer` bundle (built from each row's
   * `git_config.repoBasePath`) under the source's routing key.
   */
  async listLocalSources(): Promise<GenericWebhookSource[]> {
    return this.db
      .selectFrom('generic_webhook_sources')
      .selectAll()
      .where('provider_type', '=', 'local')
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /**
   * Update a source's configuration.
   */
  async update(id: string, input: UpdateSourceInput): Promise<GenericWebhookSource | null> {
    const updates: Record<string, unknown> = {};

    if (input.name !== undefined) updates.name = input.name;
    if (input.verificationMethod !== undefined)
      updates.verification_method = input.verificationMethod;
    if (input.verificationConfig !== undefined)
      updates.verification_config = JSON.stringify(input.verificationConfig);
    if (input.eventTypeHeader !== undefined) updates.event_type_header = input.eventTypeHeader;
    if (input.eventTypePath !== undefined) updates.event_type_path = input.eventTypePath;
    if (input.idempotencyKeyHeader !== undefined)
      updates.idempotency_key_header = input.idempotencyKeyHeader;
    if (input.idempotencyKeyPath !== undefined)
      updates.idempotency_key_path = input.idempotencyKeyPath;
    if (input.dedupWindowSeconds !== undefined)
      updates.dedup_window_seconds = input.dedupWindowSeconds;
    if (input.maxPayloadBytes !== undefined) updates.max_payload_bytes = input.maxPayloadBytes;
    if (input.allowedEvents !== undefined)
      updates.allowed_events = input.allowedEvents ? JSON.stringify(input.allowedEvents) : null;
    if (input.stripHeaders !== undefined)
      updates.strip_headers = JSON.stringify(input.stripHeaders);
    if (input.rateLimitRpm !== undefined) updates.rate_limit_rpm = input.rateLimitRpm;
    if (input.gitConfig !== undefined) {
      // `null` explicitly clears the config; a validated object re-serializes.
      if (input.gitConfig === null) {
        updates.git_config = null;
      } else {
        const validated = UniversalGitConfigSchema.parse(input.gitConfig);
        updates.git_config = JSON.stringify(validated);
        // Mirror the create-path behaviour: when the operator changes the
        // preset (e.g. switching a source from gitea to gitlab-repo) and
        // does not also pass `eventTypeHeader`, default the row's
        // `event_type_header` to the new preset's canonical header so the
        // ingester keeps classifying events correctly.
        if (input.eventTypeHeader === undefined) {
          const presetHeader = presetWebhookEventHeader(validated.preset);
          if (presetHeader) updates.event_type_header = presetHeader;
        }
      }
    }
    if (input.localConfig !== undefined) {
      // Local config shares the `git_config` column (discriminated by
      // provider_type='local'). `null` clears it; a validated object re-serializes.
      // Setting a local config also promotes the row to provider_type='local' so
      // a source created (or carried over) as a different provider_type is served
      // by the local bundle after the update.
      if (input.localConfig === null) {
        updates.git_config = null;
      } else {
        updates.git_config = JSON.stringify(LocalSourceConfigSchema.parse(input.localConfig));
        updates.provider_type = 'local';
      }
    }

    if (Object.keys(updates).length === 0) {
      return this.getById(id);
    }

    const result = await this.db
      .updateTable('generic_webhook_sources')
      .set({
        ...updates,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    if (result) {
      logger.info('Generic webhook source updated', { id, fields: Object.keys(updates) });
    }

    return result ?? null;
  }

  /**
   * Soft delete a source (sets deleted_at timestamp).
   */
  async softDelete(id: string): Promise<void> {
    await this.db
      .updateTable('generic_webhook_sources')
      .set({ deleted_at: sql`now()` })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();

    logger.info('Generic webhook source soft-deleted', { id });
  }

  /**
   * Hard delete a source (removes the row entirely).
   */
  async hardDelete(id: string): Promise<void> {
    await this.db.deleteFrom('generic_webhook_sources').where('id', '=', id).execute();

    logger.info('Generic webhook source hard-deleted', { id });
  }

  /**
   * Enable a source.
   */
  async enable(id: string): Promise<void> {
    await this.db
      .updateTable('generic_webhook_sources')
      .set({ enabled: true, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();

    logger.info('Generic webhook source enabled', { id });
  }

  /**
   * Disable a source.
   */
  async disable(id: string): Promise<void> {
    await this.db
      .updateTable('generic_webhook_sources')
      .set({ enabled: false, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();

    logger.info('Generic webhook source disabled', { id });
  }

  /**
   * Check if a request is a duplicate within the dedup window.
   * Uses the kici_events table for idempotency checking.
   *
   * @param sourceId - Source ID
   * @param idempotencyKey - Idempotency key from header or payload
   * @returns true if this is a duplicate request
   */
  async checkIdempotency(sourceId: string, idempotencyKey: string): Promise<boolean> {
    // Get source's dedup window
    const source = await this.getById(sourceId);
    if (!source) return false;

    const windowSeconds = source.dedup_window_seconds;
    const result = await this.db
      .selectFrom('kici_events')
      .select('id')
      .where('source_routing_key', '=', source.routing_key)
      .where('event_name', '=', `__dedup:${idempotencyKey}`)
      .where('created_at', '>', sql<Date>`now() - make_interval(secs => ${windowSeconds})`)
      .executeTakeFirst();

    return !!result;
  }

  /**
   * Record an idempotency marker after successful processing.
   * Inserts a `__dedup:<key>` event into kici_events so that
   * checkIdempotency can detect retries within the dedup window.
   *
   * @param sourceId - Source ID
   * @param idempotencyKey - Idempotency key from header or payload
   */
  async markIdempotency(sourceId: string, idempotencyKey: string): Promise<void> {
    const source = await this.getById(sourceId);
    if (!source) return;

    const expiresAt = new Date(Date.now() + source.dedup_window_seconds * 1000);

    await this.db
      .insertInto('kici_events')
      .values({
        event_name: `__dedup:${idempotencyKey}`,
        payload: '{}',
        source_routing_key: source.routing_key,
        source_repo: null,
        source_run_id: null,
        source_job_id: null,
        target_repos: null,
        expires_at: expiresAt,
      })
      .execute();
  }

  /**
   * Check if payload size is within the source's limit.
   *
   * @param sourceId - Source ID
   * @param bodyLength - Length of the request body in bytes
   * @returns Whether the payload is allowed and what the max is
   */
  async checkPayloadSize(
    sourceId: string,
    bodyLength: number,
  ): Promise<{ allowed: boolean; maxBytes: number }> {
    const source = await this.getById(sourceId);
    if (!source) {
      return { allowed: false, maxBytes: 0 };
    }

    return {
      allowed: bodyLength <= source.max_payload_bytes,
      maxBytes: source.max_payload_bytes,
    };
  }
}

/**
 * Return the active (non-soft-deleted) generic_webhook_sources routing keys
 * for Platform registration. Excluding soft-deleted rows is critical — if a
 * source is recreated with the same name, Platform would otherwise see the
 * orchestrator register both the stale routing key and the fresh one, and
 * end up routing a subset of orchestrators to the wrong key. This matches
 * every other query on this table that filters `deleted_at IS NULL` (see
 * `GenericSourceManager.getById`, `.list`, `.listByProviderType`, etc.).
 *
 * Returns `provider_type` alongside the routing key so callers can decide
 * whether the local orchestrator can actually serve each row. A peer that
 * cannot serve a provider_type (e.g. a `local` source whose `repoBasePath`
 * does not exist on that peer) MUST NOT advertise that routing key
 * to Platform — otherwise Platform's least-loaded relay may pick that peer
 * and the webhook is silently dropped on a pipeline that has no working
 * lock-file fetcher.
 */
export async function loadActiveGenericRoutingKeys(db: Kysely<Database>): Promise<
  Array<{
    routing_key: string;
    customer_id: string;
    provider_type: string;
    name: string;
    /** Whether the row has a non-null `git_config` (universal-git source). */
    has_git_config: boolean;
    /** Raw `git_config` JSONB. Carried so the caller can check a local source's
     *  per-row `repoBasePath` reachability via `canServeGenericProviderType`. */
    git_config: string | Record<string, unknown> | null;
  }>
> {
  const rows = await db
    .selectFrom('generic_webhook_sources')
    .select(['routing_key', 'customer_id', 'provider_type', 'name', 'git_config'])
    .where('deleted_at', 'is', null)
    .execute();
  return rows.map((row) => ({
    routing_key: row.routing_key,
    customer_id: row.customer_id,
    provider_type: row.provider_type,
    name: row.name,
    has_git_config: row.git_config !== null,
    git_config: row.git_config,
  }));
}
