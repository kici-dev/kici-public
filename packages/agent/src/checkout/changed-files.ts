import { execFileSync } from 'node:child_process';
import type { EventPayload } from '@kici-dev/sdk';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { GitAuth } from './git-clone.js';
import { setupSshAuth } from './ssh-auth.js';

/** Result of computing the changed-files list from the local clone. */
export interface ChangedFilesResult {
  files: string[];
  status: ChangedFilesStatus;
}

/**
 * Authentication context threaded into every git invocation so the deepen /
 * fetch calls that reach the remote are authenticated the same way the clone
 * was. The clone's own credentials are ephemeral (git-clone.ts wipes the SSH
 * key and never persists the token into `.git/config`), so a fetch here would
 * otherwise run unauthenticated and fail on a private remote.
 */
export interface GitAuthCtx {
  /** Per-command `-c` flags (http.extraHeader for basic auth). */
  args: string[];
  /** Env overrides (GIT_SSH_COMMAND for ssh auth). */
  env?: Record<string, string>;
  /** Tears down any temp SSH key material. */
  cleanup?: () => Promise<void>;
}

// git's canonical empty-tree object (SHA-1; kici uses git's SHA-1 defaults).
// Used as the diff base for a new-branch / zero-`before` push so every tracked
// file counts as changed. A literal constant is portable (the `hash-object
// /dev/null` form is not available on Windows agents).
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = /^0+$/;
const MAX_DEEPEN = 4; // bounded history deepening before giving up
const DEEPEN_STEP = 50;

// `safe.directory=*` lets the local diff ops read a clone owned by a different
// uid (container scaler + file:// source). `core.quotePath=false` keeps
// non-ASCII paths literal so a rule's string comparison matches.
const BASE_GIT_ARGS = ['-c', 'safe.directory=*', '-c', 'core.quotePath=false'];

/** Build the auth context for the fetches, mirroring git-clone.ts's auth. */
export async function buildAuthCtx(auth: GitAuth | undefined): Promise<GitAuthCtx> {
  if (!auth) return { args: [] };
  if (auth.kind === 'basic') {
    const user = auth.user ?? 'x-access-token';
    const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
    return { args: ['-c', `http.extraHeader=Authorization: Basic ${basic}`] };
  }
  // ssh — re-establish a temp key (the clone's was already wiped) for the fetch.
  const sshSetup = await setupSshAuth({
    privateKey: auth.secret,
    hostKeyPolicy: auth.sshHostKeyPolicy,
    knownHosts: auth.sshKnownHostsPem,
  });
  return {
    args: [],
    env: { GIT_SSH_COMMAND: sshSetup.gitSshCommand },
    cleanup: () => sshSetup.cleanup(),
  };
}

function git(workDir: string, args: string[], ctx: GitAuthCtx): string {
  return execFileSync('git', [...ctx.args, ...BASE_GIT_ARGS, '-C', workDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(ctx.env && { env: { ...process.env, ...ctx.env } }),
  });
}

function tryGit(workDir: string, args: string[], ctx: GitAuthCtx): boolean {
  try {
    git(workDir, args, ctx);
    return true;
  } catch {
    return false;
  }
}

function parseNameOnly(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter((s) => s.length > 0);
}

/** Ensure `commitish` exists locally; fetch / deepen (bounded) if not. */
function ensureCommit(workDir: string, commitish: string, ctx: GitAuthCtx): boolean {
  if (tryGit(workDir, ['cat-file', '-e', `${commitish}^{commit}`], ctx)) return true;
  if (tryGit(workDir, ['fetch', '--depth', '1', 'origin', commitish], ctx)) {
    if (tryGit(workDir, ['cat-file', '-e', `${commitish}^{commit}`], ctx)) return true;
  }
  for (let i = 0; i < MAX_DEEPEN; i++) {
    if (!tryGit(workDir, ['fetch', `--deepen=${DEEPEN_STEP}`, 'origin'], ctx)) break;
    if (tryGit(workDir, ['cat-file', '-e', `${commitish}^{commit}`], ctx)) return true;
  }
  return false;
}

function pushDiff(workDir: string, before: string, ctx: GitAuthCtx): ChangedFilesResult {
  const isZero = !before || ZERO_SHA.test(before);
  const baseRef = isZero ? EMPTY_TREE_SHA : before;
  if (!isZero && !ensureCommit(workDir, before, ctx)) {
    return { files: [], status: 'unavailable' };
  }
  const out = git(workDir, ['diff', '--name-only', baseRef, 'HEAD'], ctx);
  return { files: parseNameOnly(out), status: 'fetched' };
}

function prDiff(workDir: string, base: string, ctx: GitAuthCtx): ChangedFilesResult {
  // Base may already be a local ref, or need fetching into origin/<base>.
  const candidates = [base, `origin/${base}`, 'FETCH_HEAD'];
  const resolveBase = (): string | undefined =>
    candidates.find((c) => tryGit(workDir, ['rev-parse', '--verify', `${c}^{commit}`], ctx));
  let baseRef = resolveBase();
  if (!baseRef) {
    if (!ensureCommit(workDir, base, ctx)) return { files: [], status: 'unavailable' };
    baseRef = resolveBase();
  }
  if (!baseRef) return { files: [], status: 'unavailable' };
  // Deepen (bounded) until a merge-base with HEAD exists, then three-dot diff.
  for (let i = 0; i <= MAX_DEEPEN; i++) {
    if (tryGit(workDir, ['merge-base', baseRef, 'HEAD'], ctx)) {
      const out = git(workDir, ['diff', '--name-only', `${baseRef}...HEAD`], ctx);
      return { files: parseNameOnly(out), status: 'fetched' };
    }
    if (!tryGit(workDir, ['fetch', `--deepen=${DEEPEN_STEP}`, 'origin'], ctx)) break;
  }
  return { files: [], status: 'unavailable' };
}

/**
 * Compute the changed-files list from the agent's local clone (HEAD is the
 * checked-out head commit). Ground truth for job/step rule evaluation. `auth`
 * (the same credentials used for the clone) authenticates the deepen / fetch
 * calls so a private remote resolves. Returns `unavailable` for diff-less
 * events (schedule/tag/manual) or any git failure — never throws.
 */
export async function computeChangedFiles(
  workDir: string,
  event: EventPayload,
  auth?: GitAuth,
): Promise<ChangedFilesResult> {
  let ctx: GitAuthCtx | undefined;
  try {
    if (event.type !== 'push' && event.type !== 'pull_request') {
      return { files: [], status: 'unavailable' };
    }
    ctx = await buildAuthCtx(auth);
    if (event.type === 'push') {
      const before = (event.payload as { before?: string } | undefined)?.before ?? '';
      return pushDiff(workDir, before, ctx);
    }
    const base = event.baseBranch ?? event.targetBranch;
    if (!base) return { files: [], status: 'unavailable' };
    return prDiff(workDir, base, ctx);
  } catch {
    return { files: [], status: 'unavailable' };
  } finally {
    if (ctx?.cleanup) await ctx.cleanup().catch(() => {});
  }
}
