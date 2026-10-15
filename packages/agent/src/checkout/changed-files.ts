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

export interface ChangedFilesResult {
  files: string[];
  status: ChangedFilesStatus;
}

/**
 * Auth for the deepen / fetch calls, mirroring the clone's. The clone's own
 * credentials are ephemeral (git-clone.ts wipes the SSH key and never persists
 * the token into `.git/config`), so without this a fetch fails on a private
 * remote.
 */
export interface GitAuthCtx {
  /** Per-command `-c` flags (http.extraHeader for basic auth). */
  args: string[];
  /** GIT_SSH_COMMAND for ssh auth. */
  env?: Record<string, string>;
  /** Tears down temp SSH key material. */
  cleanup?: () => Promise<void>;
}

const Kind = diffRangeKindSchema.enum;
const MAX_DEEPEN = 4; // bounded history deepening before giving up
const DEEPEN_STEP = 50;

// `safe.directory=*` lets the local diff ops read a clone owned by a different
// uid (container scaler + file:// source). `core.quotePath=false` keeps
// non-ASCII paths literal so a rule's string comparison matches.
const BASE_GIT_ARGS = ['-c', 'safe.directory=*', '-c', 'core.quotePath=false'];

export async function buildAuthCtx(auth: GitAuth | undefined): Promise<GitAuthCtx> {
  if (!auth) return { args: [] };
  if (auth.kind === 'basic') {
    const user = auth.user ?? 'x-access-token';
    const basic = Buffer.from(`${user}:${auth.secret}`).toString('base64');
    return { args: ['-c', `http.extraHeader=Authorization: Basic ${basic}`] };
  }
  // ssh: a fresh temp key, since the clone's was already wiped.
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
  // The clone is shallow and single-branch (`--depth` implies it), so the base
  // is usually absent. Fetch it into its own remote-tracking ref: a bare
  // `fetch origin <base>` lands only in FETCH_HEAD, which the next fetch
  // overwrites, and a FETCH_HEAD left by the clone's fetch of HEAD would diff
  // HEAD against itself and report no changes.
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
  // Deepen (bounded) until a merge-base exists. Each round deepens both sides:
  // the base through its refspec (keeping the base ref current), `head`
  // through its own commit.
  for (let i = 0; i <= MAX_DEEPEN; i++) {
    if (tryGit(workDir, ['merge-base', baseRef, head], ctx)) {
      const out = git(workDir, ['diff', '--name-only', `${baseRef}...${head}`], ctx);
      return { files: parseNameOnly(out), status: 'fetched' };
    }
    if (!tryGit(workDir, ['fetch', `--deepen=${DEEPEN_STEP}`, 'origin', baseSpec], ctx)) break;
    deepenCommit(workDir, head, ctx);
  }
  return { files: [], status: 'unavailable' };
}

/**
 * Deepen the shallow history behind `commitish` by DEEPEN_STEP commits.
 *
 * On git 2.54+, a `--deepen` fetch moves only the shallow boundaries of the
 * refs it fetches; deepening the base's refspec, even naming `head`'s commit in
 * the same fetch, leaves `head`'s boundary in place. A separate absolute
 * `--depth` fetch of the commit moves it on every git version; the depth counts
 * from the commits present, so history never shrinks. Best effort: a remote
 * refusing a fetch by commit id leaves only the base deepened.
 */
function deepenCommit(workDir: string, commitish: string, ctx: GitAuthCtx): void {
  let sha: string;
  let present: number;
  try {
    sha = git(workDir, ['rev-parse', '--verify', `${commitish}^{commit}`], ctx).trim();
    present = Number(git(workDir, ['rev-list', '--count', sha], ctx).trim());
  } catch {
    return;
  }
  // fails-when: on git 2.54+, a deepen through the base's refspec alone never reaches head's boundary
  // breaks-if-wrong: a depth below the commits present would shorten head's history
  tryGit(workDir, ['fetch', `--depth=${present + DEEPEN_STEP}`, 'origin', sha], ctx);
}

/**
 * The changed files from the agent's local clone — ground truth for job/step
 * rules, the workflow filter and deferred `paths` — over the orchestrator's
 * range (`resolveDiffRange`): a push diffs the event's `before` / `after`
 * (fetched when missing); a pull request diffs its base against the
 * checked-out head. `auth` is the clone's credentials.
 *
 * `unavailable` for an event with no range (schedule/tag/manual, a push
 * without `before` or `after`, a new branch with no other default branch) and
 * for any git failure. A deleted branch is `fetched` with no files. Never
 * throws.
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
