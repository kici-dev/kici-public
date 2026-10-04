/**
 * A coordinator's own peer credential.
 *
 * Credential rows are otherwise written only by the inbound side of a token
 * join, so a coordinator without a join token would never hold one and every
 * outbound peer connection it opened would fail to authenticate. Every
 * coordinator writes to the shared cluster database, the same authority
 * `kici-admin peer create-token` writes to, so the coordinator's
 * `PeerAuthCoordinator` runs this the first time a peer client has no other
 * way to authenticate. A coordinator that never dials a peer never runs it.
 *
 * A credential an operator revoked is never re-issued. An operator revoke
 * leaves the instance no unrevoked row and marks nothing else; the supersede in
 * `PeerCredentialStore.save()` always inserts an unrevoked row, and a
 * retirement (below) marks the row with `RETIRED_BY_INSTANCE_KEY`.
 *
 * When the credential file names another instance whose self-issued
 * credential it still holds, that instance is this orchestrator's previous run
 * (a new `instanceId` per boot), and its row is retired unless the instance is
 * still live — a live one is another process sharing this file.
 */
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger, sha256, toErrorMessage, type Logger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { instanceLivenessGraceMs, isInstanceLive } from './instance-heartbeat.js';
import {
  PeerCredentialIssuance,
  PeerCredentialStore,
  RETIRED_BY_INSTANCE_KEY,
  readCredentialFile,
  writeCredentialFile,
  type CredentialFileData,
  type PeerCredential,
} from './peer-credentials.js';

const moduleLogger = createLogger({ prefix: 'coordinator-credential' });

const COORDINATOR_ROLE = 'coordinator';

/** What one reconciliation did. */
export enum CoordinatorCredentialOutcome {
  Valid = 'valid',
  Issued = 'issued',
  Replaced = 'replaced',
  Revoked = 'revoked',
  Failed = 'failed',
}

/** Why a new credential was issued, recorded on the issue log line. */
export enum CredentialIssueReason {
  NoCredential = 'no-credential',
  Expired = 'expired',
  FileMissing = 'credential-file-missing',
  FileMismatch = 'credential-file-mismatch',
}

/** What a coordinator's own cluster database says about a credential a peer rejected. */
export enum RejectionCorroboration {
  /** An unrevoked, unexpired row holds this credential: the peer's rejection is not this cluster's view. */
  HeldValid = 'held-valid',
  /** No live row holds it: the rejection is right, and the file goes. */
  NotHeld = 'not-held',
  /** The database could not be read: keep the file and retry on the next attempt. */
  Unreadable = 'unreadable',
}

/**
 * The `corroborateRejection` callback a coordinator's `PeerAuthCoordinator`
 * runs before it deletes its credential file after a peer rejected it. Any
 * dialled endpoint can send a rejection, so the coordinator's own database
 * decides: an expired or revoked row does not hold the credential, and the file
 * then goes so the self-issue path reconciles.
 */
export function coordinatorRejectionCorroborator(opts: {
  db: Kysely<Database>;
  instanceId: string;
  logger?: Logger;
}): (credential: string) => Promise<RejectionCorroboration> {
  const store = new PeerCredentialStore(opts.db);
  const log = opts.logger ?? moduleLogger;
  return async (credential) => {
    try {
      const row = await store.findByInstanceId(opts.instanceId);
      return row && row.credentialHash === sha256(credential)
        ? RejectionCorroboration.HeldValid
        : RejectionCorroboration.NotHeld;
    } catch (err) {
      log.warn('Could not read this coordinator peer credential to check a peer rejection', {
        instanceId: opts.instanceId,
        error: toErrorMessage(err),
      });
      return RejectionCorroboration.Unreadable;
    }
  };
}

export const COORDINATOR_CREDENTIAL_REVOKED_MESSAGE =
  'Peer credential for this coordinator was revoked; not issuing a new one';

const REVOKED_REMEDY =
  'Create a token with `kici-admin peer create-token --role coordinator`, restart this ' +
  'coordinator with KICI_CLUSTER_JOIN_TOKEN set to it, and remove the variable after it joins';

export type CoordinatorCredentialStore = Pick<
  PeerCredentialStore,
  'save' | 'findUnrevokedByInstanceId' | 'findLatestRevokedByInstanceId' | 'retireSelfIssued'
>;

export interface EnsureCoordinatorCredentialOptions {
  store: CoordinatorCredentialStore;
  /** Absolute path of the credential file, with `~` already expanded. */
  credentialFile: string;
  instanceId: string;
  /** Whether an instance has a live `cluster_instances` heartbeat. */
  isInstanceLive: (instanceId: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => Date;
}

/**
 * Make sure this coordinator holds a credential its peers accept, issuing one
 * when it has none. Never throws: a failure is logged and reported as `Failed`.
 */
export async function ensureCoordinatorCredential(
  opts: EnsureCoordinatorCredentialOptions,
): Promise<CoordinatorCredentialOutcome> {
  const logger = opts.logger ?? moduleLogger;
  try {
    return await reconcile(opts, logger);
  } catch (err) {
    logger.error(
      'Could not issue this coordinator its peer credential; its outbound peer connections stay unauthenticated',
      {
        instanceId: opts.instanceId,
        credentialFile: opts.credentialFile,
        error: toErrorMessage(err),
      },
    );
    return CoordinatorCredentialOutcome.Failed;
  }
}

/** The `selfIssue` callback the coordinator's `PeerAuthCoordinator` runs. */
export function coordinatorSelfIssuer(opts: {
  db: Kysely<Database>;
  credentialFile: string;
  instanceId: string;
  agentMaxReconnectDelayMs: number;
  clusterInstanceHeartbeatMs: number;
}): () => Promise<CoordinatorCredentialOutcome> {
  const store = new PeerCredentialStore(opts.db);
  const graceMs = instanceLivenessGraceMs(
    opts.agentMaxReconnectDelayMs * 2,
    opts.clusterInstanceHeartbeatMs,
  );
  return () =>
    ensureCoordinatorCredential({
      store,
      credentialFile: opts.credentialFile,
      instanceId: opts.instanceId,
      isInstanceLive: (id) => isInstanceLive(opts.db, id, graceMs),
    });
}

async function reconcile(
  opts: EnsureCoordinatorCredentialOptions,
  logger: Logger,
): Promise<CoordinatorCredentialOutcome> {
  const { store, credentialFile, instanceId } = opts;
  const now = opts.now?.() ?? new Date();
  const file = await readCredentialFileOrNull(credentialFile, logger);

  const unrevoked = await store.findUnrevokedByInstanceId(instanceId);
  if (unrevoked && unrevoked.expiresAt > now) {
    const matches =
      file?.instanceId === instanceId && sha256(file.credential) === unrevoked.credentialHash;
    if (matches) return CoordinatorCredentialOutcome.Valid;
    const reason = file ? CredentialIssueReason.FileMismatch : CredentialIssueReason.FileMissing;
    await issue(opts, logger, reason, file, now);
    return CoordinatorCredentialOutcome.Replaced;
  }

  if (!unrevoked) {
    const revoked = await store.findLatestRevokedByInstanceId(instanceId);
    if (revoked && !isRetirement(revoked)) {
      logger.error(COORDINATOR_CREDENTIAL_REVOKED_MESSAGE, {
        instanceId,
        revokedAt: revoked.revokedAt?.toISOString(),
        remedy: REVOKED_REMEDY,
      });
      return CoordinatorCredentialOutcome.Revoked;
    }
  }

  const reason = unrevoked ? CredentialIssueReason.Expired : CredentialIssueReason.NoCredential;
  await issue(opts, logger, reason, file, now);
  return CoordinatorCredentialOutcome.Issued;
}

function isRetirement(row: PeerCredential): boolean {
  return typeof row.metadata[RETIRED_BY_INSTANCE_KEY] === 'string';
}

async function issue(
  opts: EnsureCoordinatorCredentialOptions,
  logger: Logger,
  reason: CredentialIssueReason,
  file: CredentialFileData | null,
  now: Date,
): Promise<void> {
  const { store, credentialFile, instanceId } = opts;
  const credential = randomBytes(32).toString('hex');
  const { revokedCount } = await store.save({
    instanceId,
    credentialHash: sha256(credential),
    role: COORDINATOR_ROLE,
    routingKeys: [],
    metadata: { issuance: PeerCredentialIssuance.Self },
  });
  await writeCredentialFile(credentialFile, {
    instanceId,
    credential,
    role: COORDINATOR_ROLE,
    issuedAt: now.toISOString(),
  });
  logger.info('Issued this coordinator its own peer credential', {
    instanceId,
    reason,
    supersededCredentials: revokedCount,
  });
  if (file && file.instanceId !== instanceId) await retirePrevious(opts, logger, file);
}

/**
 * Retire the self-issued credential the file held for another instance. A
 * failure here is logged and never undoes the issuance that just succeeded.
 */
async function retirePrevious(
  opts: EnsureCoordinatorCredentialOptions,
  logger: Logger,
  file: CredentialFileData,
): Promise<void> {
  const previousInstanceId = file.instanceId;
  const meta = {
    instanceId: opts.instanceId,
    previousInstanceId,
    credentialFile: opts.credentialFile,
  };
  try {
    if (await opts.isInstanceLive(previousInstanceId)) {
      logger.warn(
        'The peer credential file belonged to an instance with a recent heartbeat, so its credential is kept until it expires. After a crash this is the previous run; otherwise another orchestrator shares this KICI_CLUSTER_CREDENTIAL_FILE and needs its own',
        meta,
      );
      return;
    }
    const retired = await opts.store.retireSelfIssued({
      instanceId: previousInstanceId,
      credentialHash: sha256(file.credential),
      retiredByInstance: opts.instanceId,
    });
    if (retired) {
      logger.info('Retired the peer credential a previous run of this orchestrator issued', meta);
    }
  } catch (err) {
    logger.warn('Could not retire the previous peer credential; it expires on its own', {
      ...meta,
      error: toErrorMessage(err),
    });
  }
}

async function readCredentialFileOrNull(
  credentialFile: string,
  logger: Logger,
): Promise<CredentialFileData | null> {
  try {
    const data = await readCredentialFile(credentialFile);
    if (data === null) return null;
    if (typeof data.instanceId === 'string' && typeof data.credential === 'string') return data;
    throw new Error('missing instanceId or credential');
  } catch (err) {
    logger.warn('Ignoring unreadable peer credential file', {
      credentialFile,
      error: toErrorMessage(err),
    });
    return null;
  }
}
