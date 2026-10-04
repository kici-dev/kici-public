/**
 * Join handler: answers join protocol v2 requests from new orchestrators, whether they
 * arrive through the Platform relay or on POST /api/v1/cluster/join.
 *
 * It finds the join token row by the request's routing fields, verifies the joiner's
 * proof against each candidate row, claims the row by hash, and seals the configuration
 * bundle (database URL, object storage, secrets key, cluster ID) to the joiner's
 * one-time key. A version-1 frame (one that carries the token) is refused before any
 * lookup.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  INVALID_JOIN_REQUEST_MESSAGE,
  JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
  JoinErrorCode,
  JoinRequestKind,
  buildJoinRefusal,
  classifyJoinRequest,
  type JoinRequest,
  type JoinResponse,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';

import {
  INVALID_JOIN_TOKEN_MESSAGE,
  JoinTokenManager,
  ResolvedJoinTokenStatus,
  TOKEN_ALREADY_USED_MESSAGE,
  TOKEN_EXPIRED_MESSAGE,
  decodeJoinRouting,
  tokenFingerprint,
  type JoinRoutingClaim,
} from './join-token.js';
import {
  deriveJoinKeys,
  loadX25519PublicKey,
  requestTranscript,
  sealJoinResponse,
  verifyJoinerProof,
} from './join-protocol-v2.js';
import type { ClusterIdentity } from './cluster-identity.js';
import type { SharedConfigStore } from '../config/shared-store.js';

const logger = createLogger({ prefix: 'join-handler' });

interface JoinHandlerDeps {
  db: Kysely<any>;
  sharedConfigStore: SharedConfigStore;
  clusterIdentity: ClusterIdentity;
  databaseUrl: string;
  /**
   * This orchestrator's own secrets key (`KICI_SECRET_KEY` or its key file). The
   * bundle carries it when the shared configuration holds no `secrets.key`.
   */
  secretKey?: string;
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
    externalEndpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
  };
  secretKey?: string;
  clusterId: string;
}

/** The answer to a failure the joiner cannot act on; the detail goes to the log. */
export const JOIN_INTERNAL_ERROR_MESSAGE = 'Internal error';

/** Claim failures the joiner can act on, by the message `claimByHash` throws. */
const CLAIM_ERROR_CODES: ReadonlyMap<string, JoinErrorCode> = new Map([
  [TOKEN_ALREADY_USED_MESSAGE, JoinErrorCode.enum.token_already_used],
  [TOKEN_EXPIRED_MESSAGE, JoinErrorCode.enum.token_expired],
  [INVALID_JOIN_TOKEN_MESSAGE, JoinErrorCode.enum.invalid_token],
]);

interface DecodedJoinRequest {
  claim: JoinRoutingClaim;
  joinerPublicKey: Buffer;
  requestT: Buffer;
}

export class JoinHandler {
  private readonly tokenManager: JoinTokenManager;

  constructor(private readonly deps: JoinHandlerDeps) {
    this.tokenManager = new JoinTokenManager({ db: deps.db });
  }

  /**
   * Answer one join.request frame. Every frame gets exactly one answer, a refused
   * version-1 or malformed one included. Echoes the request's messageId for Platform
   * relay correlation. A failure the joiner cannot act on (a database outage) carries
   * no errorCode and a generic message.
   */
  async handleJoinRequest(raw: unknown): Promise<JoinResponse> {
    const classified = classifyJoinRequest(raw);
    if (classified.kind === JoinRequestKind.enum.v1_removed) {
      logger.warn('Refused a version-1 join.request', { messageId: classified.messageId });
      return buildJoinRefusal(
        classified.messageId,
        JoinErrorCode.enum.join_protocol_v1_removed,
        JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
      );
    }
    if (classified.kind === JoinRequestKind.enum.invalid) {
      return buildJoinRefusal(
        classified.messageId,
        JoinErrorCode.enum.invalid_request,
        INVALID_JOIN_REQUEST_MESSAGE,
      );
    }
    const request = classified.request;
    const decoded = decodeRequest(request);
    if (!decoded) {
      return buildJoinRefusal(
        request.messageId,
        JoinErrorCode.enum.invalid_request,
        INVALID_JOIN_REQUEST_MESSAGE,
      );
    }
    try {
      return await this.answer(request, decoded);
    } catch (err) {
      const error = toErrorMessage(err);
      logger.warn('Join request rejected', { error });
      const code = CLAIM_ERROR_CODES.get(error);
      // The requester is unauthenticated until its proof is checked, so an
      // unmapped failure (a database error naming a host or user) stays in the log.
      return code
        ? buildJoinRefusal(request.messageId, code, error)
        : {
            type: 'join.response',
            messageId: request.messageId,
            success: false,
            error: JOIN_INTERNAL_ERROR_MESSAGE,
          };
    }
  }

  private async answer(request: JoinRequest, decoded: DecodedJoinRequest): Promise<JoinResponse> {
    const { claim, joinerPublicKey, requestT } = decoded;
    const resolved = await this.tokenManager.resolveLiveTokenByRouting(claim, (tokenHash) =>
      verifyJoinerProof(
        deriveJoinKeys(Buffer.from(tokenHash, 'hex')),
        requestT,
        request.joinerProof,
      ),
    );
    if (resolved.status === ResolvedJoinTokenStatus.enum.unknown) {
      return buildJoinRefusal(
        request.messageId,
        JoinErrorCode.enum.invalid_token,
        INVALID_JOIN_TOKEN_MESSAGE,
      );
    }
    if (resolved.status === ResolvedJoinTokenStatus.enum.expired) {
      return buildJoinRefusal(
        request.messageId,
        JoinErrorCode.enum.token_expired,
        TOKEN_EXPIRED_MESSAGE,
      );
    }
    // The bootstrap join carries no peer instance id; the joiner routing-key label is
    // both consumer and instance, so a joiner retrying its own token is allowed again.
    const label = `joiner:${claim.routingKey}`;
    const claimed = await this.tokenManager.claimByHash(resolved.tokenHash, label, label);
    const bundle = await this.buildConfigBundle();
    const sealed = sealJoinResponse({
      keys: deriveJoinKeys(Buffer.from(claimed.tokenHash, 'hex')),
      requestT,
      joinerPublicKey,
      bundle,
    });
    logger.info('Join request accepted', {
      orgId: claimed.routing.orgId,
      routingKey: claimed.routing.routingKey,
      clusterId: bundle.clusterId,
      tokenFingerprint: tokenFingerprint(claimed.tokenHash),
    });
    return { type: 'join.response', messageId: request.messageId, success: true, ...sealed };
  }

  /**
   * Build the config bundle from SharedConfig + local config. The secrets key is
   * the shared configuration's `secrets.key`, else this orchestrator's own key, so
   * a joined orchestrator decrypts what the cluster encrypted.
   */
  async buildConfigBundle(): Promise<ConfigBundle> {
    const sharedResult = await this.deps.sharedConfigStore.getLatest();
    const shared = sharedResult?.config ?? {};

    const clusterId = await this.deps.clusterIdentity.getClusterId();

    return {
      databaseUrl: this.deps.databaseUrl,
      storage: shared.storage,
      secretKey: shared.secrets?.key ?? this.deps.secretKey,
      clusterId,
    };
  }
}

/** Decode the routing part and the joiner key, and build the request transcript; null when malformed. */
function decodeRequest(request: JoinRequest): DecodedJoinRequest | null {
  try {
    const claim = decodeJoinRouting(request.routing);
    const joinerPublicKey = Buffer.from(request.joinerPublicKey, 'base64');
    loadX25519PublicKey(joinerPublicKey);
    const requestT = requestTranscript(
      request.routing,
      joinerPublicKey,
      Buffer.from(request.joinerNonce, 'base64'),
    );
    return { claim, joinerPublicKey, requestT };
  } catch {
    return null;
  }
}
