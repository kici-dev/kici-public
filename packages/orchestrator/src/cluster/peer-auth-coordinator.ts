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
 */
import { unlink } from 'node:fs/promises';
import { createLogger } from '@kici-dev/shared';
import {
  readCredentialFile,
  writeCredentialFile,
  type CredentialFileData,
} from './peer-credentials.js';

const logger = createLogger({ prefix: 'peer-auth-coordinator' });

/** How long a waiting peer-client awaits an in-flight sibling token-join. */
const DEFAULT_JOIN_WAIT_TIMEOUT_MS = 10_000;
/** Max read→await→re-read cycles before a waiter gives up and joins/aborts. */
const MAX_DECIDE_ITERATIONS = 3;

export type AuthDecision =
  | { mode: 'credential'; credential: CredentialFileData }
  | { mode: 'token-join'; token: string; complete: (issued: CredentialFileData | null) => void }
  | { mode: 'no-auth' };

export type RejectionAction = 'retry-credential' | 'rejoin';

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

  /** Promise-chain mutex tail; every file op awaits the prior one. */
  private lock: Promise<unknown> = Promise.resolve();
  /** Set while one peer-client is mid token-join; siblings await it. */
  private inFlightJoin: Deferred<CredentialFileData | null> | null = null;

  constructor(opts: {
    credentialFile: string;
    instanceId: string;
    joinToken?: string;
    joinWaitTimeoutMs?: number;
  }) {
    this.credentialFile = opts.credentialFile;
    this.instanceId = opts.instanceId;
    this.joinToken = opts.joinToken;
    this.joinWaitTimeoutMs = opts.joinWaitTimeoutMs ?? DEFAULT_JOIN_WAIT_TIMEOUT_MS;
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
    const cred = await readCredentialFile(this.credentialFile);
    return cred && cred.instanceId === this.instanceId ? cred : null;
  }

  async decideAuth(): Promise<AuthDecision> {
    for (let i = 0; i < MAX_DECIDE_ITERATIONS; i++) {
      const decision = await this.withLock(async (): Promise<AuthDecision | 'await-join'> => {
        const cred = await this.readValidCredential();
        if (cred) return { mode: 'credential', credential: cred };
        if (this.inFlightJoin) return 'await-join';
        if (this.joinToken) {
          const join = deferred<CredentialFileData | null>();
          this.inFlightJoin = join;
          return { mode: 'token-join', token: this.joinToken, complete: this.makeComplete(join) };
        }
        return { mode: 'no-auth' };
      });

      if (decision !== 'await-join') return decision;
      await this.awaitInFlightJoin();
    }
    // Exhausted retries: fall back to a token-join if possible, else no-auth.
    if (this.joinToken) {
      const join = deferred<CredentialFileData | null>();
      this.inFlightJoin = join;
      return { mode: 'token-join', token: this.joinToken, complete: this.makeComplete(join) };
    }
    return { mode: 'no-auth' };
  }

  private makeComplete(join: Deferred<CredentialFileData | null>) {
    return (issued: CredentialFileData | null): void => {
      void this.withLock(async () => {
        if (issued) {
          await writeCredentialFile(this.credentialFile, issued);
        }
        if (this.inFlightJoin === join) this.inFlightJoin = null;
        join.resolve(issued);
      });
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
        return 'retry-credential';
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
      return 'rejoin';
    });
  }
}
