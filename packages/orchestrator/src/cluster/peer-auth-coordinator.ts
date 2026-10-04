/**
 * Per-orchestrator coordinator that owns the shared peer credential file.
 *
 * A single orchestrator runs N peer-clients (one per cluster peer) that all
 * share one identity-scoped credential file. Left uncoordinated, a reconnect
 * storm makes each sibling independently token-join (each join revokes the
 * prior credential, invalidating the others) and delete the shared file on any
 * rejection — a credential revocation cascade. This coordinator serializes all
 * file access through one in-process mutex so only one peer-client token-joins
 * per storm, and it never deletes a credential file a sibling has refreshed.
 *
 * A coordinator without a join token also wires a `selfIssue` callback. When a
 * decision finds no credential and no token, the callback issues the
 * coordinator its own credential, once per storm, under the same mutex.
 *
 * A coordinator also wires `corroborateRejection`. Any dialled endpoint can
 * send a rejection, so before it deletes the file the coordinator asks its own
 * cluster database: a credential the database holds as valid, or a database it
 * cannot read, keeps the file.
 */
import { unlink } from 'node:fs/promises';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  readCredentialFile,
  writeCredentialFile,
  type CredentialFileData,
} from './peer-credentials.js';
import { runDetached } from '../helpers/run-detached.js';
import { CoordinatorCredentialOutcome, RejectionCorroboration } from './coordinator-credential.js';

const logger = createLogger({ prefix: 'peer-auth-coordinator' });

/** How long a waiting peer-client awaits an in-flight sibling token-join. */
const DEFAULT_JOIN_WAIT_TIMEOUT_MS = 10_000;
/** Max read→await→re-read cycles before a waiter gives up and joins/aborts. */
const MAX_DECIDE_ITERATIONS = 3;

export type AuthDecision =
  | { mode: 'credential'; credential: CredentialFileData }
  | { mode: 'token-join'; token: string; complete: (issued: CredentialFileData | null) => void }
  | { mode: 'no-auth' };

/** What `reportRejection` did with the credential file. */
export enum RejectionAction {
  /** A sibling refreshed the file: retry with the fresh credential. */
  RetryCredential = 'retry-credential',
  /** The file was deleted: the next decision token-joins or self-issues. */
  Rejoin = 'rejoin',
  /** This cluster's database holds the credential as valid (or is unreadable): the file stays. */
  KeepCredential = 'keep-credential',
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class PeerAuthCoordinator {
  private readonly credentialFile: string;
  private readonly instanceId: string;
  private readonly joinToken?: string;
  private readonly joinWaitTimeoutMs: number;
  private readonly selfIssue?: () => Promise<CoordinatorCredentialOutcome>;
  private readonly corroborateRejection?: (credential: string) => Promise<RejectionCorroboration>;
  /** The issuance in progress; concurrent sibling clients share it. */
  private selfIssueInFlight: Promise<CoordinatorCredentialOutcome> | null = null;
  /** An operator revoked this coordinator's credential: never issue again in this process. */
  private selfIssueRevoked = false;

  /** Promise-chain mutex tail; every file op awaits the prior one. */
  private lock: Promise<unknown> = Promise.resolve();
  /** Set while one peer-client is mid token-join; siblings await it. */
  private inFlightJoin: Deferred<CredentialFileData | null> | null = null;

  constructor(opts: {
    credentialFile: string;
    instanceId: string;
    joinToken?: string;
    joinWaitTimeoutMs?: number;
    /**
     * Issues this coordinator its own credential when a decision finds no
     * credential and no join token. Only a coordinator wires it.
     */
    selfIssue?: () => Promise<CoordinatorCredentialOutcome>;
    /**
     * Asks this coordinator's own cluster database whether it holds a rejected
     * credential as valid. Only a coordinator with a database wires it.
     */
    corroborateRejection?: (credential: string) => Promise<RejectionCorroboration>;
  }) {
    this.credentialFile = opts.credentialFile;
    this.instanceId = opts.instanceId;
    this.joinToken = opts.joinToken;
    this.joinWaitTimeoutMs = opts.joinWaitTimeoutMs ?? DEFAULT_JOIN_WAIT_TIMEOUT_MS;
    this.selfIssue = opts.selfIssue;
    this.corroborateRejection = opts.corroborateRejection;
  }

  /** Run `fn` exclusively against the credential file. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Keep the chain alive even if fn rejects, without unhandled-rejection noise.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readValidCredential(): Promise<CredentialFileData | null> {
    let cred: CredentialFileData | null;
    try {
      cred = await readCredentialFile(this.credentialFile);
    } catch (err) {
      logger.warn('Ignoring unreadable peer credential file', {
        instanceId: this.instanceId,
        path: this.credentialFile,
        error: toErrorMessage(err),
      });
      return null;
    }
    return cred && cred.instanceId === this.instanceId ? cred : null;
  }

  async decideAuth(): Promise<AuthDecision> {
    let selfIssueTried = false;
    for (let i = 0; i < MAX_DECIDE_ITERATIONS; i++) {
      const decision = await this.withLock(
        async (): Promise<AuthDecision | 'await-join' | 'self-issue'> => {
          const cred = await this.readValidCredential();
          if (cred) return { mode: 'credential', credential: cred };
          if (this.inFlightJoin) return 'await-join';
          if (this.joinToken) {
            const join = deferred<CredentialFileData | null>();
            this.inFlightJoin = join;
            return { mode: 'token-join', token: this.joinToken, complete: this.makeComplete(join) };
          }
          if (this.selfIssue && !selfIssueTried && !this.selfIssueRevoked) return 'self-issue';
          return { mode: 'no-auth' };
        },
      );

      if (decision === 'await-join') {
        await this.awaitInFlightJoin();
        continue;
      }
      if (decision === 'self-issue') {
        selfIssueTried = true;
        await this.runSelfIssue();
        continue;
      }
      return decision;
    }
    // Exhausted retries: fall back to a token-join if possible, else no-auth.
    if (this.joinToken) {
      const join = deferred<CredentialFileData | null>();
      this.inFlightJoin = join;
      return { mode: 'token-join', token: this.joinToken, complete: this.makeComplete(join) };
    }
    return { mode: 'no-auth' };
  }

  /** Run the issuer under the mutex, once for every concurrent caller. */
  private runSelfIssue(): Promise<CoordinatorCredentialOutcome> {
    const selfIssue = this.selfIssue;
    if (!selfIssue) return Promise.resolve(CoordinatorCredentialOutcome.Failed);
    this.selfIssueInFlight ??= this.withLock(selfIssue)
      .then((outcome) => {
        if (outcome === CoordinatorCredentialOutcome.Revoked) this.selfIssueRevoked = true;
        return outcome;
      })
      .finally(() => {
        this.selfIssueInFlight = null;
      });
    return this.selfIssueInFlight;
  }

  private makeComplete(join: Deferred<CredentialFileData | null>) {
    return (issued: CredentialFileData | null): void => {
      runDetached(
        logger,
        'Peer token-join completion',
        () =>
          this.withLock(async () => {
            if (issued) {
              await writeCredentialFile(this.credentialFile, issued);
            }
            if (this.inFlightJoin === join) this.inFlightJoin = null;
            join.resolve(issued);
          }),
        { instanceId: this.instanceId },
      );
    };
  }

  private async awaitInFlightJoin(): Promise<void> {
    const join = this.inFlightJoin;
    if (!join) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(() => {
        // Hung joiner: drop the stale handle so this waiter can become joiner.
        if (this.inFlightJoin === join) this.inFlightJoin = null;
        logger.warn('In-flight peer token-join timed out; waiter will retry', {
          instanceId: this.instanceId,
        });
        res();
      }, this.joinWaitTimeoutMs);
    });
    await Promise.race([join.promise.then(() => undefined), timeout]);
    if (timer) clearTimeout(timer);
  }

  async reportRejection(provedCredential: string | null, reason: string): Promise<RejectionAction> {
    return this.withLock(async () => {
      const cred = await this.readValidCredential();
      if (cred && cred.credential !== provedCredential) {
        // A sibling refreshed the file since this proof was computed — do not
        // delete it; the next decideAuth will use the fresh credential.
        logger.info('Credential refreshed by sibling; retrying credential auth', {
          instanceId: this.instanceId,
          reason,
        });
        return RejectionAction.RetryCredential;
      }
      if (cred && this.corroborateRejection) {
        const verdict = await this.corroborateRejection(cred.credential);
        if (verdict !== RejectionCorroboration.NotHeld) {
          logger.warn(
            'A peer rejected a credential this cluster holds as valid; keeping the credential file',
            { instanceId: this.instanceId, reason, verdict },
          );
          return RejectionAction.KeepCredential;
        }
      }
      // Genuinely stale (or absent): delete so the next decideAuth token-joins.
      try {
        await unlink(this.credentialFile);
        logger.warn('Deleted stale credential file after server rejection', {
          instanceId: this.instanceId,
          reason,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn('Failed to delete stale credential file', {
            instanceId: this.instanceId,
            path: this.credentialFile,
          });
        }
      }
      return RejectionAction.Rejoin;
    });
  }
}
