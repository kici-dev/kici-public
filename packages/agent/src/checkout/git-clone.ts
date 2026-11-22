// execFileSync, not zx: zx's PowerShell quoting mangles Windows backslash paths.

import { execFileSync } from 'node:child_process';
import { setupSshAuth, type SshAuthSetup } from './ssh-auth.js';

/**
 * Mirrors the protocol's `gitAuthSchema`: HTTPS Basic (GitHub App tokens, PATs)
 * or SSH (universal-git, pinned host keys).
 */
export interface GitAuth {
  kind: 'basic' | 'ssh';
  user?: string;
  /** Basic-auth password/PAT, or PEM-encoded SSH private key. */
  secret: string;
  /** SSH-only; defaults to `accept-new`. */
  sshHostKeyPolicy?: 'accept-new' | 'pinned';
  /** SSH-only. Required when `sshHostKeyPolicy === 'pinned'`. */
  sshKnownHostsPem?: string;
}

interface CloneOptions {
  repoUrl: string;
  /** Branch or tag; empty clones the default branch. */
  ref: string;
  /** Expected commit, verified after the clone. */
  sha: string;
  workDir: string;
  /** Basic goes through `http.extraHeader`; SSH through `GIT_SSH_COMMAND` with a temp key. */
  gitAuth?: GitAuth;
  /** 0 = full history (no --depth). Defaults to 1. */
  depth?: number;
  /** Unset: git's default tags. true: every tag. false: --no-tags. */
  fetchTags?: boolean;
  /** Later git network operations ask this helper for a freshly minted credential. */
  credentialHelperPath?: string;
  /** Set, the temp SSH key is handed to the job instead of deleted, so a later step can push. */
  sshCleanupRegistry?: SshCleanupRegistry;
}

export interface SshCleanupRegistry {
  defer(cleanup: () => Promise<void>): void;
}

/**
 * Point a clone at the agent's credential helper. Only the helper path, never a
 * secret, lands in `.git/config`. `useHttpPath` adds `path=owner/repo.git` to
 * every query, so a write grant can be confined to its own repo.
 */
export function configureCredentialHelper(workDir: string, helperPath: string): void {
  execFileSync('git', ['-C', workDir, 'config', 'credential.helper', helperPath], {
    stdio: 'pipe',
    timeout: 10_000,
  });
  execFileSync('git', ['-C', workDir, 'config', 'credential.useHttpPath', 'true'], {
    stdio: 'pipe',
    timeout: 10_000,
  });
}

/**
 * execFileSync errors embed the full command line, which would leak the Base64
 * `http.extraHeader` token or the temp SSH key path into logs.
 */
function sanitizeGitError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const sanitized = new Error(redactSensitive(error.message));
  sanitized.stack = error.stack ? redactSensitive(error.stack) : undefined;
  return sanitized;
}

function redactSensitive(input: string): string {
  return input
    .replace(
      /http\.extraHeader=Authorization: Basic \S+/g,
      'http.extraHeader=Authorization: Basic [REDACTED]',
    )
    .replace(/'[^']*kici-ssh-[^']*'/g, "'[REDACTED_SSH_PATH]'")
    .replace(/\S*kici-ssh-\S+/g, '[REDACTED_SSH_PATH]');
}

/** `-c http.extraHeader` for Basic auth; SSH auth rides GIT_SSH_COMMAND in the env instead. */
function authConfigArgs(auth: GitAuth | undefined): string[] {
  if (auth?.kind !== 'basic') return [];
  // `x-access-token` is the GitHub App install-token username.
  const user = auth.user ?? 'x-access-token';
  const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

/** `git clone` argv after the auth `-c`: depth (0 = full history), tag policy, ref, URL, target. */
function buildCloneArgs(
  options: Pick<CloneOptions, 'repoUrl' | 'ref' | 'workDir' | 'depth' | 'fetchTags'>,
): string[] {
  const { repoUrl, ref, workDir, depth = 1, fetchTags } = options;
  const args = ['clone'];
  if (depth > 0) args.push('--depth', String(depth));
  if (fetchTags === false) args.push('--no-tags');
  if (ref) args.push('--branch', ref);
  args.push(repoUrl, workDir);
  return args;
}

interface GitRun {
  workDir: string;
  auth: GitAuth | undefined;
  envOpts: { env?: Record<string, string> };
}

/** A network `git fetch` in the work dir, with the clone's auth and a redacted error. */
function authFetch(run: GitRun, fetchArgs: string[]): void {
  try {
    execFileSync('git', ['-C', run.workDir, ...authConfigArgs(run.auth), 'fetch', ...fetchArgs], {
      stdio: 'pipe',
      timeout: 120_000,
      ...run.envOpts,
    });
  } catch (err) {
    throw sanitizeGitError(err);
  }
}

function checkoutSha(run: GitRun, sha: string): void {
  execFileSync('git', ['-C', run.workDir, 'checkout', sha], {
    stdio: 'pipe',
    timeout: 30_000,
    ...run.envOpts,
  });
}

function headSha(run: GitRun): string {
  return execFileSync('git', ['-C', run.workDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    timeout: 10_000,
    ...run.envOpts,
  }).trim();
}

/**
 * Move HEAD to the expected commit when the branch advanced since the webhook.
 * A full clone (depth 0) usually holds the commit already, so it checks out
 * first and fetches the commit only if that fails, never with `--depth`
 * (which would make the repository shallow). A shallow clone deepens by at
 * least 50 commits, or by its own depth when that is larger.
 */
function checkoutExpectedSha(run: GitRun, sha: string, depth: number): void {
  if (depth === 0) {
    try {
      checkoutSha(run, sha);
    } catch {
      authFetch(run, ['origin', sha]);
      checkoutSha(run, sha);
    }
  } else {
    authFetch(run, ['--depth', String(Math.max(50, depth)), 'origin', sha]);
    checkoutSha(run, sha);
  }
  const recheckedSha = headSha(run);
  if (!recheckedSha.startsWith(sha)) {
    throw new Error(`SHA mismatch: expected ${sha}, got ${recheckedSha}`);
  }
}

/**
 * Clone at a ref (shallow by default), then verify HEAD is the expected SHA to prevent
 * wrong-ref execution. `-c http.extraHeader` keeps a token out of the URL
 * (`git remote -v`, logs).
 *
 * @throws Error if clone fails or SHA does not match
 */
export async function gitClone(options: CloneOptions): Promise<void> {
  const {
    repoUrl,
    ref,
    sha,
    workDir,
    gitAuth,
    depth = 1,
    fetchTags,
    credentialHelperPath,
    sshCleanupRegistry,
  } = options;

  const auth: GitAuth | undefined = gitAuth;

  const envEntries: Record<string, string> = {};
  let needsCustomEnv = false;
  let safeDirCleanup: (() => Promise<void>) | undefined;

  // file://: disable safe.directory, since in rootless podman the bind-mounted
  // repo's host UID differs from the container UID. The `upload-pack` child
  // ignores `GIT_CONFIG_KEY_*` and `-c safe.directory`, so write a temp config
  // and point `GIT_CONFIG_GLOBAL` at it; every inheriting git re-reads it.
  if (repoUrl.startsWith('file://')) {
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { makeTempDir } = await import('@kici-dev/core/tmp');
    const { path: dir, cleanup } = await makeTempDir('gitcfg');
    const cfgPath = path.join(dir, 'config');
    await writeFile(cfgPath, '[safe]\n\tdirectory = *\n', { mode: 0o600 });
    envEntries.GIT_CONFIG_GLOBAL = cfgPath;
    needsCustomEnv = true;
    safeDirCleanup = async () => {
      await cleanup().catch(() => {});
    };
  }

  let sshSetup: SshAuthSetup | undefined;
  try {
    if (auth?.kind === 'ssh') {
      sshSetup = await setupSshAuth({
        privateKey: auth.secret,
        hostKeyPolicy: auth.sshHostKeyPolicy,
        knownHosts: auth.sshKnownHostsPem,
      });
      envEntries.GIT_SSH_COMMAND = sshSetup.gitSshCommand;
      needsCustomEnv = true;
    }

    const env: Record<string, string> | undefined = needsCustomEnv
      ? ({ ...process.env, ...envEntries } as Record<string, string>)
      : undefined;

    const args = [
      ...authConfigArgs(auth),
      ...buildCloneArgs({ repoUrl, ref, workDir, depth, fetchTags }),
    ];
    try {
      execFileSync('git', args, { stdio: 'pipe', timeout: 120_000, ...(env && { env }) });
    } catch (err) {
      throw sanitizeGitError(err);
    }

    const run: GitRun = { workDir, auth, envOpts: env ? { env } : {} };

    // A shallow clone follows only the tags inside its history; fetch every tag
    // at the same depth. A full clone already holds them.
    if (fetchTags === true && depth > 0) {
      authFetch(run, ['--depth', String(depth), '--tags', 'origin']);
    }

    // Before the SHA check, which can return early.
    if (credentialHelperPath) {
      configureCredentialHelper(workDir, credentialHelperPath);
    }

    if (!sha || sha === 'HEAD') return;

    if (!headSha(run).startsWith(sha)) {
      checkoutExpectedSha(run, sha, depth);
    }
  } finally {
    if (sshSetup) {
      if (sshCleanupRegistry) {
        // Holding the key for the job is safe: SSH keys do not expire.
        const setup = sshSetup;
        sshCleanupRegistry.defer(() => setup.cleanup().catch(() => {}));
      } else {
        await sshSetup.cleanup().catch(() => {
          /* best effort — tempdir is in $TMPDIR and will be reaped eventually */
        });
      }
    }
    if (safeDirCleanup) {
      await safeDirCleanup();
    }
  }
}
