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
import { rehomeSourceRegistrations } from './source-org.js';
import { isDefaultGithubUrl } from '../providers/github/github-host.js';

const logger = createLogger({ prefix: 'source-store' });

/** Fixed org_id for source secrets (sources are not org-scoped in the orchestrator). */
const SOURCE_ORG_ID = '__system__';

export interface AddSourceParams {
  /** Provider type (e.g. 'github') */
  provider: string;
  /** Human-readable source name */
  name: string;
  /** GitHub App slug (the authoritative URL-safe identifier). Optional. */
  slug?: string;
  /** App ID for the provider (used to build routing key) */
  appId: string;
  /** Private key (PEM format for GitHub Apps) */
  privateKey: string;
  /** Webhook secret for signature verification */
  webhookSecret?: string;
  /** Extra non-sensitive config */
  config?: Record<string, unknown>;
  /**
   * Web URL of the GitHub Enterprise Server the App lives on, already
   * validated. Stored in the `github_url` column only for a server other than
   * github.com.
   */
  githubUrl?: string;
  /** Customer/org identifier for secret and environment scoping */
  customerId?: string;
}

/**
 * A source with this routing key already exists. For a GitHub App, the
 * routing key is `github:<appId>` on every GitHub server.
 */
export class DuplicateSourceError extends Error {
  constructor(provider: string, appId: string, routingKey: string) {
    super(
      provider === 'github'
        ? `Source with routing key ${routingKey} already exists: an orchestrator holds one source ` +
            `per GitHub App id; App id ${appId} is already registered as ${routingKey}. A second ` +
            'App with the same id belongs on another orchestrator, in another organization.'
        : `Source with routing key ${routingKey} already exists`,
    );
    this.name = 'DuplicateSourceError';
  }
}

/**
 * Drop the keys a generic config write must not set: `appId` is derived from
 * the routing key, and the customer (the source's org) has its own, separately
 * authorized field. `githubUrl` is dropped too: the server lives in the
 * `github_url` column, and a `config.githubUrl` is never read.
 */
function withoutReservedConfigKeys(config: Record<string, unknown>): Record<string, unknown> {
  const {
    appId: _appId,
    githubUrl: _githubUrl,
    customerId: _customerId,
    customer_id: _customerIdColumn,
    ...rest
  } = config;
  return rest;
}

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

    const existing = await this.db
      .selectFrom('sources')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();

    if (existing) {
      throw new DuplicateSourceError(params.provider, params.appId, routingKey);
    }

    // breaks-if-wrong: a github.com source's config stays exactly {"appId":"<id>"}
    const configJson = JSON.stringify({
      ...withoutReservedConfigKeys(params.config ?? {}),
      appId: params.appId,
    });

    const source = await this.db
      .insertInto('sources')
      .values({
        provider: params.provider,
        name: params.name,
        routing_key: routingKey,
        config: configJson,
        slug: params.slug ?? null,
        github_url: isDefaultGithubUrl(params.githubUrl) ? null : params.githubUrl,
        ...(params.customerId ? { customer_id: params.customerId } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

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

  async getSource(routingKey: string): Promise<Source | null> {
    const source = await this.db
      .selectFrom('sources')
      .selectAll()
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();

    return source ?? null;
  }

  /**
   * Get a single source by its UUID primary key, or null if not found. Used by
   * the direct GitHub ingress route, which receives the source id in the URL
   * (`/webhook/:orgId/github/:sourceId`).
   */
  async getSourceById(id: string): Promise<Source | null> {
    const source = await this.db
      .selectFrom('sources')
      .selectAll()
      .where('id', '=', id)
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
   * Update a source's name/config and optionally rotate secrets. A new
   * `customerId` moves the source's registrations to that org in the same
   * transaction, so the source and its registrations never disagree.
   */
  async updateSource(
    routingKey: string,
    updates: {
      name?: string;
      /** New GitHub App slug. `null` clears it; `undefined` leaves it unchanged. */
      slug?: string | null;
      privateKey?: string;
      webhookSecret?: string;
      config?: Record<string, unknown>;
      /**
       * New GitHub Enterprise Server web URL, already validated and authorized.
       * `null` (or github.com) clears it; `undefined` leaves it unchanged.
       */
      githubUrl?: string | null;
      /** New customer/org identifier (used for secret + environment scoping). */
      customerId?: string;
    },
  ): Promise<Source> {
    // First get the source to find its ID for secret updates
    const source = await this.getSource(routingKey);
    if (!source) {
      throw new Error(`Source with routing key ${routingKey} not found`);
    }

    const dbUpdates: Record<string, unknown> = { updated_at: sql`now()` };
    if (updates.name) dbUpdates.name = updates.name;
    if (updates.slug !== undefined) dbUpdates.slug = updates.slug;
    if (updates.customerId) dbUpdates.customer_id = updates.customerId;
    if (updates.githubUrl !== undefined) {
      dbUpdates.github_url =
        updates.githubUrl === null || isDefaultGithubUrl(updates.githubUrl)
          ? null
          : updates.githubUrl;
    }
    if (updates.config) {
      const existingConfig =
        typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
      // fails-when: a scoped token can move a source through the config merge
      dbUpdates.config = JSON.stringify({
        ...existingConfig,
        ...withoutReservedConfigKeys(updates.config),
      });
    }

    // Apply DB updates (always runs -- at minimum updates updated_at)
    {
      const orgChanged = !!updates.customerId && updates.customerId !== source.customer_id;
      const updated = await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('sources')
          .set(dbUpdates)
          .where('routing_key', '=', routingKey)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (orgChanged) {
          const moved = await rehomeSourceRegistrations(trx, routingKey, updates.customerId!);
          logger.info('Moved source registrations to its new org', {
            routingKey,
            orgId: updates.customerId,
            moved,
          });
        }
        return row;
      });

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

    const scope = `__source__/${source.id}`;
    await this.secretStore.deleteSecret(SOURCE_ORG_ID, scope, 'privateKey');
    await this.secretStore.deleteSecret(SOURCE_ORG_ID, scope, 'webhookSecret');

    await this.db.deleteFrom('sources').where('routing_key', '=', routingKey).execute();

    logger.info('Source removed', { routingKey });
  }
}
