/**
 * Source store for orchestrator webhook source management.
 *
 * Provides CRUD operations for the sources table with secret storage
 * via PgSecretStore. Secrets (private keys, webhook secrets) are stored
 * separately from the source config to leverage the existing encryption
 * infrastructure.
 */
import { type Kysely, sql } from 'kysely';
import type { Database, Source } from '../db/types.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'source-store' });

/** Fixed org_id for source secrets (sources are not org-scoped in the orchestrator). */
const SOURCE_ORG_ID = '__system__';

/**
 * Parameters for adding a new source.
 */
export interface AddSourceParams {
  /** Provider type (e.g. 'github') */
  provider: string;
  /** Human-readable source name */
  name: string;
  /** App ID for the provider (used to build routing key) */
  appId: string;
  /** Private key (PEM format for GitHub Apps) */
  privateKey: string;
  /** Webhook secret for signature verification */
  webhookSecret?: string;
  /** Extra non-sensitive config */
  config?: Record<string, unknown>;
  /** Customer/org identifier for secret and environment scoping */
  customerId?: string;
}

/**
 * A source with its decrypted secrets.
 */
export interface SourceWithSecrets extends Source {
  privateKey: string;
  webhookSecret?: string;
}

/**
 * CRUD store for webhook sources backed by PostgreSQL.
 * Sensitive credentials are stored in PgSecretStore under `__source__/<id>`.
 */
export class SourceStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly secretStore: PgSecretStore,
  ) {}

  /**
   * Add a new source. Stores config in sources table, secrets in PgSecretStore.
   * Routing key is computed as `<provider>:<appId>`.
   */
  async addSource(params: AddSourceParams): Promise<Source> {
    const routingKey = `${params.provider}:${params.appId}`;

    // Check for duplicate routing key
    const existing = await this.db
      .selectFrom('sources')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();

    if (existing) {
      throw new Error(`Source with routing key ${routingKey} already exists`);
    }

    const configJson = JSON.stringify({ ...params.config, appId: params.appId });

    const source = await this.db
      .insertInto('sources')
      .values({
        provider: params.provider,
        name: params.name,
        routing_key: routingKey,
        config: configJson,
        ...(params.customerId ? { customer_id: params.customerId } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Store secrets
    const scope = `__source__/${source.id}`;
    await this.secretStore.setSecret(SOURCE_ORG_ID, scope, 'privateKey', params.privateKey);
    if (params.webhookSecret) {
      await this.secretStore.setSecret(SOURCE_ORG_ID, scope, 'webhookSecret', params.webhookSecret);
    }

    logger.info('Source added', { routingKey, name: params.name });
    return source;
  }

  /**
   * List all sources (no secrets exposed).
   */
  async listSources(): Promise<Source[]> {
    return this.db.selectFrom('sources').selectAll().execute();
  }

  /**
   * Get a single source by routing key, or null if not found.
   */
  async getSource(routingKey: string): Promise<Source | null> {
    const source = await this.db
      .selectFrom('sources')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();

    return source ?? null;
  }

  /**
   * Get a source with its decrypted secrets.
   */
  async getSourceWithSecrets(routingKey: string): Promise<SourceWithSecrets | null> {
    const source = await this.getSource(routingKey);
    if (!source) return null;

    const scope = `__source__/${source.id}`;
    const secrets = await this.secretStore.getSecrets(SOURCE_ORG_ID, scope);

    if (!secrets.privateKey) {
      logger.error('Source missing private key in secret store', {
        routingKey,
        sourceId: source.id,
      });
      return null;
    }

    return {
      ...source,
      privateKey: secrets.privateKey,
      ...(secrets.webhookSecret ? { webhookSecret: secrets.webhookSecret } : {}),
    };
  }

  /**
   * Update a source's name/config and optionally rotate secrets.
   */
  async updateSource(
    routingKey: string,
    updates: {
      name?: string;
      privateKey?: string;
      webhookSecret?: string;
      config?: Record<string, unknown>;
      /** New customer/org identifier (used for secret + environment scoping). */
      customerId?: string;
    },
  ): Promise<Source> {
    // First get the source to find its ID for secret updates
    const source = await this.getSource(routingKey);
    if (!source) {
      throw new Error(`Source with routing key ${routingKey} not found`);
    }

    // Build DB update set
    const dbUpdates: Record<string, unknown> = { updated_at: sql`now()` };
    if (updates.name) dbUpdates.name = updates.name;
    if (updates.customerId) dbUpdates.customer_id = updates.customerId;
    if (updates.config) {
      const existingConfig =
        typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
      // Strip appId from updates — it's derived from the routing key and must not be overwritten
      const { appId: _, ...safeConfig } = updates.config;
      dbUpdates.config = JSON.stringify({ ...existingConfig, ...safeConfig });
    }

    // Apply DB updates (always runs -- at minimum updates updated_at)
    {
      const updated = await this.db
        .updateTable('sources')
        .set(dbUpdates)
        .where('routing_key', '=', routingKey)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Update secrets if provided
      const scope = `__source__/${source.id}`;
      if (updates.privateKey) {
        await this.secretStore.setSecret(SOURCE_ORG_ID, scope, 'privateKey', updates.privateKey);
      }
      if (updates.webhookSecret) {
        await this.secretStore.setSecret(
          SOURCE_ORG_ID,
          scope,
          'webhookSecret',
          updates.webhookSecret,
        );
      }

      logger.info('Source updated', { routingKey });
      return updated;
    }
  }

  /**
   * Remove a source and its associated secrets.
   */
  async removeSource(routingKey: string): Promise<void> {
    const source = await this.getSource(routingKey);
    if (!source) return;

    // Delete secrets
    const scope = `__source__/${source.id}`;
    await this.secretStore.deleteSecret(SOURCE_ORG_ID, scope, 'privateKey');
    await this.secretStore.deleteSecret(SOURCE_ORG_ID, scope, 'webhookSecret');

    // Delete from DB
    await this.db.deleteFrom('sources').where('routing_key', '=', routingKey).execute();

    logger.info('Source removed', { routingKey });
  }
}
