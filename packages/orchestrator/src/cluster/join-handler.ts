/**
 * Join handler for processing join requests from new orchestrators.
 *
 * Supports both Platform relay and direct peer transport. When a new orchestrator
 * sends a join.request with a kici_join_v1 token, this handler:
 * 1. Validates the token (exists in DB, not expired, not consumed)
 * 2. Builds a config bundle (DB URL, S3 config, secrets key, cluster ID)
 * 3. Encrypts the bundle with the token-derived AES-256-GCM key
 * 4. Consumes the token (one-time use)
 * 5. Returns the encrypted bundle to the joiner
 *
 * The Platform relay sees only routing metadata and ciphertext -- zero-knowledge.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { JoinRequest, JoinResponse } from '@kici-dev/engine';
import type { Kysely } from 'kysely';

import { JoinTokenManager, encryptBundle, parseToken } from './join-token.js';
import type { ClusterIdentity } from './cluster-identity.js';
import type { SharedConfigStore } from '../config/shared-store.js';

const logger = createLogger({ prefix: 'join-handler' });

interface JoinHandlerDeps {
  db: Kysely<any>;
  sharedConfigStore: SharedConfigStore;
  clusterIdentity: ClusterIdentity;
  databaseUrl: string;
}

/**
 * Config bundle distributed to new orchestrators via join token.
 * Contains everything needed to configure and start an orchestrator instance.
 */
export interface ConfigBundle {
  databaseUrl: string;
  storage?: {
    type?: 's3';
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
  };
  secretKey?: string;
  clusterId: string;
}

export class JoinHandler {
  private readonly tokenManager: JoinTokenManager;

  constructor(private readonly deps: JoinHandlerDeps) {
    this.tokenManager = new JoinTokenManager({ db: deps.db });
  }

  /**
   * Handle a join request from a new orchestrator.
   * Validates token, builds config bundle, encrypts with token-derived key, consumes token.
   * Echoes messageId from request for Platform relay correlation.
   */
  async handleJoinRequest(request: JoinRequest): Promise<JoinResponse> {
    try {
      // 1. Atomically validate and consume the token (single round-trip,
      //    only one caller can win the claim across a shared-DB mesh).
      //    parseToken first so the consumedBy label carries the routing key
      //    even before the DB claim succeeds.
      const previewRouting = parseToken(request.token).routing;
      // The config-bundle bootstrap join.request carries no peer instanceId on
      // the wire — it is a one-shot fetch of the encrypted config bundle keyed
      // by the join token, not the ongoing per-peer mesh auth. Use the joiner
      // routing-key label as both the consumedBy and the consuming instanceId so
      // a joiner that retries the same bootstrap token (same routing key) is
      // allowed the same self-healing reuse, while a different routing key is
      // rejected as already-used.
      const joinerLabel = `joiner:${previewRouting.routingKey}`;
      const { routing, keys } = await this.tokenManager.validateAndConsumeToken(
        request.token,
        joinerLabel,
        joinerLabel,
      );

      // 2. Build config bundle
      const bundle = await this.buildConfigBundle();

      // 3. Encrypt bundle with token-derived key
      const encrypted = encryptBundle(bundle, keys.encryptionKey);
      const encryptedB64 = encrypted.toString('base64');

      logger.info('Join request accepted', {
        orgId: routing.orgId,
        routingKey: routing.routingKey,
        clusterId: bundle.clusterId,
      });

      return {
        type: 'join.response',
        messageId: request.messageId,
        success: true,
        encryptedBundle: encryptedB64,
      };
    } catch (err) {
      const errorMsg = toErrorMessage(err);
      logger.warn('Join request rejected', { error: errorMsg });
      return {
        type: 'join.response',
        messageId: request.messageId,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Build the config bundle from SharedConfig + local config.
   */
  async buildConfigBundle(): Promise<ConfigBundle> {
    const sharedResult = await this.deps.sharedConfigStore.getLatest();
    const shared = sharedResult?.config ?? {};

    const clusterId = await this.deps.clusterIdentity.getClusterId();

    return {
      databaseUrl: this.deps.databaseUrl,
      storage: shared.storage,
      secretKey: shared.secrets?.key,
      clusterId,
    };
  }
}
