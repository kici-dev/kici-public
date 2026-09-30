import { execFileSync } from 'node:child_process';
import type { EventPayload } from '@kici-dev/sdk';
import {
  diffRangeKindSchema,
  resolveDiffRange,
  type ChangedFilesStatus,
  type DiffRangeEvent,
} from '@kici-dev/engine';
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

const Kind = diffRangeKindSchema.enum;
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

/**
 * Two-dot `before..after`: the files a push to an existing branch changed.
 * Diffed against the event's `after`, not the checkout: a cross-source job
 * checks out the registration's commit, which is not the pushed one.
 */
function twoDotDiff(
  workDir: string,
  before: string,
  after: string,
  ctx: GitAuthCtx,
): ChangedFilesResult {
  // fails-when: a checkout at another commit diffs before..HEAD instead of before..after
  // breaks-if-wrong: a checkout at `after` (every same-source job) diffs as before, with no fetch
  if (!ensureCommit(workDir, before, ctx) || !ensureCommit(workDir, after, ctx)) {
    return { files: [], status: 'unavailable' };
  }
  const out = git(workDir, ['diff', '--name-only', before, after], ctx);
  return { files: parseNameOnly(out), status: 'fetched' };
}

/**
 * Three-dot `base...head`: the files `head` adds relative to `base` — a pull
 * request's base branch against the checkout, or a new branch's default branch
 * against the pushed `after`.
 */
function prDiff(workDir: string, base: string, ctx: GitAuthCtx, head = 'HEAD'): ChangedFilesResult {
  if (!ensureCommit(workDir, head, ctx)) return { files: [], status: 'unavailable' };
  // The agent's clone is shallow and single-branch (`--depth` implies it), so
  // the base branch is usually absent. Fetch it into its own remote-tracking
  // ref: a bare `fetch origin <base>` lands only in FETCH_HEAD, which the next
  // fetch overwrites — and a FETCH_HEAD left by the clone's own fetch of HEAD
  // would diff HEAD against itself and report no changed files.
  const baseSpec = `+refs/heads/${base}:refs/remotes/origin/${base}`;
  const resolveBase = (): string | undefined =>
    [base, `origin/${base}`].find((c) =>
      tryGit(workDir, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], ctx),
    );
  let baseRef = resolveBase();
  if (!baseRef) {
    // fails-when: a single-branch clone resolves no base and reports unavailable
    // breaks-if-wrong: a clone that already holds the base branch never fetches
    tryGit(workDir, ['fetch', '--depth', '1', 'origin', baseSpec], ctx);
    baseRef = resolveBase();
  }
  if (!baseRef) return { files: [], status: 'unavailable' };
  // Deepen (bounded) until a merge-base with HEAD exists, then three-dot diff.
  // Deepening through the base's refspec moves every shallow boundary, HEAD's
  // included, and keeps the base ref current.
  for (let i = 0; i <= MAX_DEEPEN; i++) {
    if (tryGit(workDir, ['merge-base', baseRef, head], ctx)) {
      const out = git(workDir, ['diff', '--name-only', `${baseRef}...${head}`], ctx);
      return { files: parseNameOnly(out), status: 'fetched' };
    }
    if (!tryGit(workDir, ['fetch', `--deepen=${DEEPEN_STEP}`, 'origin', baseSpec], ctx)) break;
  }
  return { files: [], status: 'unavailable' };
}

/**
 * Compute the changed-files list from the agent's local clone, over the same
 * range the orchestrator uses (`resolveDiffRange`): a push reads the event's
 * own `before` / `after` commits, fetching them when the checkout lacks them;
 * a pull request diffs its base against the checked-out head. Ground truth for job/step rules, the workflow filter
 * and deferred `paths`. `auth` (the same credentials used for the clone)
 * authenticates the deepen / fetch calls so a private remote resolves.
 *
 * Returns `unavailable` for an event with no range — a diff-less event
 * (schedule/tag/manual), a push without `before` or `after`, a new branch
 * with no other default branch to diff against — and for any git failure.
 * A deleted branch is `fetched` with no files. Never throws.
 */
export async function computeChangedFiles(
  workDir: string,
  event: EventPayload,
  auth?: GitAuth,
): Promise<ChangedFilesResult> {
  const range = resolveDiffRange(event as unknown as DiffRangeEvent);
  if (range.kind === Kind.none) return { files: [], status: 'unavailable' };
  if (range.kind === Kind.deleted) return { files: [], status: 'fetched' };
  let ctx: GitAuthCtx | undefined;
  try {
    ctx = await buildAuthCtx(auth);
    if (range.kind === Kind['two-dot']) return twoDotDiff(workDir, range.base, range.head, ctx);
    if (range.kind === Kind['new-branch']) {
      return prDiff(workDir, range.defaultBranch, ctx, range.head);
    }
    return prDiff(workDir, range.base, ctx);
  } catch {
    return { files: [], status: 'unavailable' };
  } finally {
    if (ctx?.cleanup) await ctx.cleanup().catch(() => {});
  }
}
