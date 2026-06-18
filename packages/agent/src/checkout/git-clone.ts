// Git operations use execFileSync directly (not zx) to avoid
// PowerShell quoting issues with Windows paths containing backslashes.

import { setupSshAuth, type SshAuthSetup } from './ssh-auth.js';

/**
 * Structured clone auth. Mirrors `gitAuthSchema` on the orchestrator-agent
 * protocol so a single shape carries both HTTPS Basic (GitHub App tokens,
 * PATs) and SSH (universal-git, pinned host keys).
 */
export interface GitAuth {
  kind: 'basic' | 'ssh';
  /** Basic-auth username. Omit for SSH. */
  user?: string;
  /** Basic-auth password/PAT, or PEM-encoded SSH private key. */
  secret: string;
  /** SSH-only. `accept-new` (default) or `pinned`. */
  sshHostKeyPolicy?: 'accept-new' | 'pinned';
  /** SSH-only. Required when `sshHostKeyPolicy === 'pinned'`. */
  sshKnownHostsPem?: string;
}

/**
 * Options for cloning a git repository.
 */
interface CloneOptions {
  /** Full HTTPS repo URL (e.g., https://github.com/org/repo.git) */
  repoUrl: string;
  /** Git ref to checkout (branch name or tag) */
  ref: string;
  /** Expected commit SHA (for verification after clone) */
  sha: string;
  /** Directory to clone into */
  workDir: string;
  /**
   * Optional auth token (GitHub installation token or personal token).
   * Deprecated in favour of `gitAuth`; retained for backward compatibility
   * during the Phase 4 universal-git rollout. When both are set, `gitAuth`
   * wins.
   */
  token?: string;
  /**
   * Structured auth material. When `kind === 'basic'`, gitAuth is used
   * instead of `token` via the same `http.extraHeader` path. When
   * `kind === 'ssh'`, the clone uses `GIT_SSH_COMMAND` with a temp
   * private key (and optional pinned known_hosts).
   */
  gitAuth?: GitAuth;
  /** Clone depth (default: 1 for shallow clone) */
  depth?: number;
}

/**
 * Strip auth credentials from git error messages to prevent token leakage.
 * Node's execFileSync includes the full command line (including -c http.extraHeader
 * and GIT_SSH_COMMAND flags) in error messages, which would expose Base64-encoded
 * tokens or the absolute path of a temporary SSH key file in logs.
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
 * Shallow-clone a git repository at a specific ref with optional token auth.
 *
 * Token authentication uses git's `-c http.extraHeader` mechanism which keeps
 * the token out of the clone URL (not visible in `git remote -v` or logs).
 *
 * After clone, verifies that HEAD matches the expected SHA to prevent
 * wrong-ref execution.
 *
 * @throws Error if clone fails or SHA does not match
 */
export async function gitClone(options: CloneOptions): Promise<void> {
  const { repoUrl, ref, sha, workDir, token, gitAuth, depth = 1 } = options;

  // Normalise the auth inputs:
  //   - When both `gitAuth` and `token` are set, `gitAuth` wins (Phase 4 is
  //     the structured path; `token` is a transition-window fallback).
  //   - When only `token` is set, we synthesize a Basic-auth GitAuth so the
  //     rest of the function has a single code path.
  const auth: GitAuth | undefined = gitAuth
    ? gitAuth
    : token
      ? { kind: 'basic', user: 'x-access-token', secret: token }
      : undefined;

  // Build git clone args and optional env overrides
  const args: string[] = [];
  const envEntries: Record<string, string> = {};
  let needsCustomEnv = false;
  let safeDirCleanup: (() => Promise<void>) | undefined;

  // For file:// URLs, disable git's safe.directory check. The agent runs in a
  // rootless-podman container where the bind-mounted source repo's host UID
  // does not match the container UID. `GIT_CONFIG_KEY_*` env vars and `-c
  // safe.directory` flags are NOT honoured by the `upload-pack` subprocess
  // git spawns to read the source repo for a file:// clone, so we have to
  // write a temp gitconfig file and point `GIT_CONFIG_GLOBAL` at it — that
  // path is re-read by every git process that inherits the env.
  if (repoUrl.startsWith('file://')) {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'kici-gitcfg-'));
    const cfgPath = path.join(dir, 'config');
    await writeFile(cfgPath, '[safe]\n\tdirectory = *\n', { mode: 0o600 });
    envEntries.GIT_CONFIG_GLOBAL = cfgPath;
    needsCustomEnv = true;
    safeDirCleanup = async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  }

  let sshSetup: SshAuthSetup | undefined;
  try {
    if (auth?.kind === 'basic') {
      // HTTPS Basic auth via `http.extraHeader` — keeps the secret out of
      // the clone URL (not visible in `git remote -v` or logs). Default
      // username is `x-access-token` for GitHub App install tokens.
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

    // When ref is empty, clone the default branch (omit --branch)
    if (ref) {
      args.push('clone', '--depth', String(depth), '--branch', ref, repoUrl, workDir);
    } else {
      args.push('clone', '--depth', String(depth), repoUrl, workDir);
    }

    // Execute clone using execFileSync to bypass zx/PowerShell quoting issues
    // on Windows (backslashes in paths get mangled by PowerShell's quote function).
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', args, { stdio: 'pipe', timeout: 120_000, ...(env && { env }) });
    } catch (err) {
      throw sanitizeGitError(err);
    }

    // Verify HEAD matches expected SHA (skip when sha is empty or 'HEAD' — no specific commit to verify)
    if (!sha || sha === 'HEAD') return;

    // Pass env overrides (e.g., safe.directory, GIT_SSH_COMMAND) to all subsequent git calls
    const envOpts = env ? { env } : {};

    const actualSha = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10_000,
      ...envOpts,
    }).trim();

    if (!actualSha.startsWith(sha)) {
      // SHA mismatch — the branch may have advanced since the webhook was received.
      // Deepen the clone to find the target commit and check it out.
      const fetchArgs: string[] = [];
      if (auth?.kind === 'basic') {
        const user = auth.user ?? 'x-access-token';
        const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
        fetchArgs.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
      }
      // SSH auth propagates via GIT_SSH_COMMAND in `env` (no per-call flag).
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

      // Re-verify after checkout
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
      await sshSetup.cleanup().catch(() => {
        /* best effort — tempdir is in $TMPDIR and will be reaped eventually */
      });
    }
    if (safeDirCleanup) {
      await safeDirCleanup();
    }
  }
}
