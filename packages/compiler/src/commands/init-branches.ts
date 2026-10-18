/** `kici init` branch detection: the default branch never falls back to the checked-out one. */

import { $ } from 'zx';

/** Where `detectDefaultBranch` found the default branch. */
export enum DefaultBranchSource {
  /** The local `refs/remotes/origin/HEAD`, which `git clone` sets. */
  OriginHead = 'origin-head',
  /** The HEAD the `origin` remote reports through `git ls-remote --symref`. */
  RemoteHead = 'remote-head',
  Fallback = 'fallback',
}

const FALLBACK_DEFAULT_BRANCH = 'main';

/** Bounds a slow or credential-prompting `origin`: init falls back instead of hanging. */
const LS_REMOTE_TIMEOUT_MS = 10_000;

const ORIGIN_REF_PREFIX = 'refs/remotes/origin/';
const REMOTE_HEAD_SYMREF = /^ref: refs\/heads\/(.+)\tHEAD$/;

export interface DetectedDefaultBranch {
  branch: string;
  source: DefaultBranchSource;
}

/** Trimmed stdout of `git <args>`, or `undefined` on failure. With stdin closed and prompts off, a remote wanting credentials fails fast. */
async function gitOutput(
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<string | undefined> {
  try {
    // zx keeps the working directory it had at import, so cwd is always passed.
    // The timeout aborts a detached process group, which zx kills with one
    // signal to the group. zx's own `timeout` lists the process tree with `ps`
    // and throws an uncaught error on a host that has no `ps`.
    const result = await $({
      cwd,
      quiet: true,
      nothrow: true,
      ...(timeoutMs === undefined
        ? {}
        : { detached: true, signal: AbortSignal.timeout(timeoutMs) }),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })`git ${args}`;
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    // A spawn failure (no git binary) still rejects under nothrow.
    return undefined;
  }
}

/** The branch in `git ls-remote --symref <remote> HEAD` output, if HEAD points under refs/heads/. */
export function parseRemoteHeadSymref(lsRemoteOutput: string): string | undefined {
  for (const line of lsRemoteOutput.split('\n')) {
    const match = REMOTE_HEAD_SYMREF.exec(line.trimEnd());
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The repository's default branch: the local `origin/HEAD`, else the HEAD the
 * `origin` remote reports, else `main`. Never the checked-out branch.
 */
export async function detectDefaultBranch(
  cwd: string,
  opts: { lsRemoteTimeoutMs?: number } = {},
): Promise<DetectedDefaultBranch> {
  const originHead = await gitOutput(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith(ORIGIN_REF_PREFIX)) {
    const branch = originHead.slice(ORIGIN_REF_PREFIX.length);
    if (branch) return { branch, source: DefaultBranchSource.OriginHead };
  }

  const lsRemote = await gitOutput(
    cwd,
    ['ls-remote', '--symref', 'origin', 'HEAD'],
    opts.lsRemoteTimeoutMs ?? LS_REMOTE_TIMEOUT_MS,
  );
  const remoteHead = lsRemote === undefined ? undefined : parseRemoteHeadSymref(lsRemote);
  if (remoteHead) return { branch: remoteHead, source: DefaultBranchSource.RemoteHead };

  return { branch: FALLBACK_DEFAULT_BRANCH, source: DefaultBranchSource.Fallback };
}

/**
 * The checked-out branch, including an unborn one in a fresh `git init`;
 * `undefined` on a detached HEAD or outside a repository.
 */
export async function detectCheckedOutBranch(cwd: string): Promise<string | undefined> {
  const branch = await gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return branch || undefined;
}
