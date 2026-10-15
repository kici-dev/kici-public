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
  /** Defaults to 1 (shallow). */
  depth?: number;
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

/**
 * Shallow-clone at a ref, then verify HEAD is the expected SHA to prevent
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
    credentialHelperPath,
    sshCleanupRegistry,
  } = options;

  const auth: GitAuth | undefined = gitAuth;

  const args: string[] = [];
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
    if (auth?.kind === 'basic') {
      // `x-access-token` is the GitHub App install-token username.
      const user = auth.user ?? 'x-access-token';
      const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
      args.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
    } else if (auth?.kind === 'ssh') {
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

    if (ref) {
      args.push('clone', '--depth', String(depth), '--branch', ref, repoUrl, workDir);
    } else {
      args.push('clone', '--depth', String(depth), repoUrl, workDir);
    }

    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', args, { stdio: 'pipe', timeout: 120_000, ...(env && { env }) });
    } catch (err) {
      throw sanitizeGitError(err);
    }

    // Before the SHA check, which can return early.
    if (credentialHelperPath) {
      configureCredentialHelper(workDir, credentialHelperPath);
    }

    if (!sha || sha === 'HEAD') return;

    const envOpts = env ? { env } : {};

    const actualSha = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10_000,
      ...envOpts,
    }).trim();

    if (!actualSha.startsWith(sha)) {
      // The branch may have advanced since the webhook: deepen to the target commit.
      const fetchArgs: string[] = [];
      if (auth?.kind === 'basic') {
        const user = auth.user ?? 'x-access-token';
        const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
        fetchArgs.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
      }
      // SSH auth rides GIT_SSH_COMMAND in `env`.
      fetchArgs.push('fetch', '--depth', '50', 'origin', sha);

      try {
        execFileSync('git', ['-C', workDir, ...fetchArgs], {
          stdio: 'pipe',
          timeout: 120_000,
          ...envOpts,
        });
      } catch (err) {
        throw sanitizeGitError(err);
      }
      execFileSync('git', ['-C', workDir, 'checkout', sha], {
        stdio: 'pipe',
        timeout: 30_000,
        ...envOpts,
      });

      const recheckedSha = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        timeout: 10_000,
        ...envOpts,
      }).trim();
      if (!recheckedSha.startsWith(sha)) {
        throw new Error(`SHA mismatch: expected ${sha}, got ${recheckedSha}`);
      }
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
