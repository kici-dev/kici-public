/**
 * Universal-git lock file fetcher.
 *
 * Implements `LockFileFetcher` from `@kici-dev/engine` by shallow-cloning the
 * source repo into a temporary directory, scoped to the `^\.kici/` path
 * whitelist via git sparse-checkout. This keeps the payload tiny (tens of
 * KiB for a normal workflows bundle) even when the repo itself is large.
 *
 * Safety caps (all enforced):
 *   - **5 MiB max** for the cloned `.kici/kici.lock.json` file. Rejected
 *     with `LockFileTooLargeError` when exceeded.
 *   - **30 s timeout** on each git invocation. The wall-clock budget for
 *     an entire fetch cycle (all git calls combined) is also 30 s.
 *   - **Path whitelist `^\.kici/`.** Enforced by `sparse-checkout set
 *     --cone .kici` so nothing outside that prefix ever hits disk.
 *
 * Auth:
 *   - HTTPS Basic (PAT / basic-auth): injected via `git -c
 *     http.extraHeader=Authorization: Basic <base64>` so the secret never
 *     appears in the repo URL / logs.
 *   - SSH: materialized via `prepareSshAuthSync()` and surfaced through
 *     `GIT_SSH_COMMAND`; tempfiles are always cleaned up in a `finally`.
 *
 * This fetcher is used at two sites:
 *   - Registration: when a default-branch push arrives for a universal-git
 *     source, the processor calls `fetchLockFile(repoId, sha, credentials)`
 *     to re-read the workflow manifest.
 *   - Global-workflow dispatch: cross-provider globals resolve the lock
 *     file via the registration's provider bundle.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LockFileFetcher, LockFile } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { resolveSourceCredential } from '../../secrets/source-credentials.js';
import type { SecretResolver } from '../../secrets/secret-resolver.js';
import type { UniversalGitConfig } from './config.js';
import { UniversalGitRepoUrlBuilder } from './repo-url.js';
import { prepareSshAuthSync } from './ssh-auth.js';

const execFileP = promisify(execFile);
const logger = createLogger({ prefix: 'universal-git:lock-file' });

/** Max lock file size in bytes (5 MiB). */
const LOCK_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Per-git-invocation timeout in milliseconds (30 s). */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/** Path under the repo root that the lock file sits at. */
const LOCK_FILE_PATH_IN_REPO = '.kici/kici.lock.json';

/** Sparse-checkout cone root. Enforces the `^\.kici/` whitelist. */
const SPARSE_PATH = '.kici';

/**
 * Typed error for the 5 MiB cap. Callers can differentiate this from
 * generic fetch failures for metrics / logging.
 */
export class LockFileTooLargeError extends Error {
  constructor(
    public readonly repoIdentifier: string,
    public readonly sizeBytes: number,
    public readonly limitBytes: number = LOCK_FILE_MAX_BYTES,
  ) {
    super(`Lock file for ${repoIdentifier} exceeded size cap: ${sizeBytes} > ${limitBytes} bytes`);
    this.name = 'LockFileTooLargeError';
  }
}

/**
 * Universal-git implementation of LockFileFetcher.
 *
 * Bound to a single source (orgId + sourceId + config). The orchestrator
 * constructs one per registered universal-git source.
 */
export class UniversalGitLockFileFetcher implements LockFileFetcher {
  readonly provider = 'generic' as const;

  private readonly repoUrlBuilder: UniversalGitRepoUrlBuilder;

  constructor(
    private readonly params: {
      orgId: string;
      sourceId: string;
      config: UniversalGitConfig;
      secretResolver: SecretResolver;
    },
  ) {
    this.repoUrlBuilder = new UniversalGitRepoUrlBuilder(params.config.gitUrlTemplate);
  }

  /**
   * Shallow-clone the source repo at `ref` into a private tempdir, read
   * `.kici/kici.lock.json`, and tear down.
   *
   * @returns The parsed `LockFile` on success, or `null` when the path
   * doesn't exist in the repo (i.e. user hasn't added a lock file yet).
   * Throws on any other failure — caller catches + emits
   * `kici_universal_git_registration_errors_total{reason}`.
   */
  async fetchLockFile(
    repoIdentifier: string,
    ref: string,
    _credentials: unknown,
  ): Promise<LockFile | null> {
    const deadline = Date.now() + GIT_COMMAND_TIMEOUT_MS;

    const cloneUrl = this.repoUrlBuilder.buildCloneUrl(repoIdentifier);
    // Detect commit SHAs (40 lowercase hex chars). `git clone --branch` only
    // accepts branch/tag names; passing a SHA fails with "Remote branch ...
    // not found". For SHAs we clone the default branch, then fetch + check
    // out the specific commit (works for any ref reachable from the default
    // branch tip, which covers every default-branch-push case).
    const isCommitSha = !!ref && /^[0-9a-f]{40}$/i.test(ref);
    const resolvedRef = ref && ref !== 'HEAD' ? ref : undefined;
    const branchHint = resolvedRef && !isCommitSha ? resolvedRef : undefined;
    const checkoutTarget = resolvedRef;

    // Resolve auth material up front so we fail fast on secret lookup.
    const authResult = await resolveSourceCredential(
      this.params.secretResolver,
      this.params.orgId,
      this.params.sourceId,
      this.params.config.credentialRef,
    );
    if (!authResult.ok) {
      throw new Error(
        `Universal-git credential resolution failed: ${authResult.reason} (${authResult.message})`,
      );
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'kici-ugit-lockfetch-'));
    let sshCleanup: (() => void) | undefined;
    let gitSshCommand: string | undefined;
    const gitConfigArgs: string[] = [];

    try {
      if (this.params.config.credentialType === 'ssh') {
        const ssh = prepareSshAuthSync({
          privateKey: authResult.value,
          policy: this.params.config.sshHostKeyPolicy,
          knownHostsPem: this.params.config.sshKnownHostsPem,
        });
        sshCleanup = ssh.cleanup;
        gitSshCommand = ssh.gitSshCommand;
      } else {
        const basicUser = resolveBasicUser(this.params.config) ?? 'x-access-token';
        const header = `Authorization: Basic ${Buffer.from(
          `${basicUser}:${authResult.value}`,
        ).toString('base64')}`;
        gitConfigArgs.push('-c', `http.extraHeader=${header}`);
      }

      // 1) `git clone --filter=blob:none --depth=1 --no-checkout <url> <dir>`
      //    — no blobs, single commit, empty worktree. The subsequent
      //    sparse-checkout call narrows the tree before we populate blobs.
      const cloneArgs: string[] = [...gitConfigArgs, 'clone'];
      cloneArgs.push('--filter=blob:none', '--depth=1', '--no-checkout', '--single-branch');
      if (branchHint) {
        cloneArgs.push('--branch', branchHint);
      }
      cloneArgs.push(cloneUrl, tempDir);

      await runGit(cloneArgs, {
        env: gitSshCommand ? { GIT_SSH_COMMAND: gitSshCommand } : undefined,
        deadline,
      });

      // 2) `git sparse-checkout init --cone`
      // 3) `git sparse-checkout set .kici`
      await runGit(['-C', tempDir, 'sparse-checkout', 'init', '--cone'], { deadline });
      await runGit(['-C', tempDir, 'sparse-checkout', 'set', SPARSE_PATH], { deadline });

      // 3b) When `ref` is a commit SHA we couldn't pass it as `--branch`, so
      //     fetch it explicitly. Forgejo / Gitea / GitLab / GitHub all enable
      //     `uploadpack.allowReachableSHA1InWant` by default, which permits
      //     fetching any commit reachable from a ref tip. For default-branch
      //     pushes the SHA is by definition reachable; for older SHAs the
      //     fetch falls back to the cloned default-branch HEAD if it 404s.
      if (isCommitSha && checkoutTarget) {
        try {
          await runGit(
            ['-C', tempDir, ...gitConfigArgs, 'fetch', '--depth=1', 'origin', checkoutTarget],
            {
              env: gitSshCommand ? { GIT_SSH_COMMAND: gitSshCommand } : undefined,
              deadline,
            },
          );
        } catch (err) {
          logger.warn('Universal-git SHA fetch failed; falling back to default-branch HEAD', {
            repoIdentifier,
            ref: checkoutTarget,
            error: toErrorMessage(err),
          });
        }
      }

      // 4) `git checkout <ref>` (or default) — now populates blobs in
      //    `.kici/**` only.
      const checkoutArgs = ['-C', tempDir, ...gitConfigArgs, 'checkout'];
      if (checkoutTarget) checkoutArgs.push(checkoutTarget);
      await runGit(checkoutArgs, {
        env: gitSshCommand ? { GIT_SSH_COMMAND: gitSshCommand } : undefined,
        deadline,
      });

      const lockPath = join(tempDir, LOCK_FILE_PATH_IN_REPO);
      let fileInfo;
      try {
        fileInfo = await stat(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.info('Universal-git lock file not present in repo', {
            repoIdentifier,
            ref: resolvedRef ?? 'HEAD',
          });
          return null;
        }
        throw err;
      }

      if (fileInfo.size > LOCK_FILE_MAX_BYTES) {
        throw new LockFileTooLargeError(repoIdentifier, fileInfo.size);
      }

      const raw = await readFile(lockPath, 'utf-8');
      const parsed = JSON.parse(raw) as LockFile;
      if (typeof parsed.schemaVersion !== 'number') {
        throw new Error(
          `Universal-git lock file at ${repoIdentifier}: missing or invalid schemaVersion`,
        );
      }
      return parsed;
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn('Failed to remove universal-git lock-file tempdir', {
          tempDir,
          error: toErrorMessage(err),
        });
      }
      if (sshCleanup) sshCleanup();
    }
  }
}

/**
 * Run a single git invocation with a shared wall-clock deadline. If the
 * remaining budget is below 1 s the call is rejected immediately so we
 * don't burn the remainder on a command that can't possibly complete.
 */
async function runGit(
  args: string[],
  opts: { deadline: number; env?: Record<string, string> },
): Promise<void> {
  const remaining = opts.deadline - Date.now();
  if (remaining < 1_000) {
    throw new Error('Universal-git lock-file fetch exceeded overall deadline');
  }
  const timeout = Math.min(remaining, GIT_COMMAND_TIMEOUT_MS);
  await execFileP('git', args, {
    timeout,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
}

/**
 * Duplicate of `clone-token.ts#resolveBasicUser` for the lock-file fetcher —
 * kept separate because the clone-token variant is exported from an async
 * provider surface, and the lock-file fetcher is synchronous / internal.
 */
function resolveBasicUser(config: UniversalGitConfig): string | undefined {
  if (config.credentialType === 'ssh') return undefined;
  if (config.credentialUser) return config.credentialUser;
  if (config.credentialType === 'pat') return 'x-access-token';
  return 'git';
}
