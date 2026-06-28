import { execSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

/** Git hosts whose origin URL we can turn into a real `owner/repo` + web link. */
export const RecognizedProvider = z.enum(['github', 'gitlab', 'bitbucket']);
export type RecognizedProvider = z.infer<typeof RecognizedProvider>;

/** Host → provider map. The keys are the canonical public hostnames. */
const HOST_PROVIDER: Record<string, RecognizedProvider> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

/** The literal provider value stamped when no recognized git origin exists. */
export const LOCAL_PROVIDER = 'local';

/**
 * Parse a git remote URL into `{ provider, owner/repo }` for a recognized host.
 * Handles scp-style ssh (`git@host:owner/repo.git`), `ssh://`, and `https://`
 * forms; strips a trailing `.git`. Returns null for any unrecognized host or
 * unparseable input.
 */
export function parseGitOrigin(
  url: string,
): { provider: RecognizedProvider; repoIdentifier: string } | null {
  const trimmed = url.trim();
  // scp-style: git@github.com:owner/repo(.git)
  const scp = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  // url-style: scheme://[user@]host/owner/repo(.git)
  const urlStyle = /^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  const match = scp ?? urlStyle;
  if (!match) return null;
  const host = match[1].toLowerCase();
  const provider = HOST_PROVIDER[host];
  if (!provider) return null;
  const repoIdentifier = match[2].replace(/^\/+|\/+$/g, '');
  if (!repoIdentifier.includes('/')) return null;
  return { provider, repoIdentifier };
}

/** Read the `origin` remote URL of the working tree at `repoRoot`, or null. */
export function detectGitOrigin(repoRoot: string): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the repo identity stamped on a `kici run remote` run. A recognized git
 * origin yields the real `owner/repo` + provider so the dashboard can link to
 * it; otherwise a synthetic `local/<basename>` identity with provider `local`.
 */
export function buildLocalRepoIdentity(repoRoot: string): {
  repoIdentifier: string;
  provider: string;
} {
  const origin = detectGitOrigin(repoRoot);
  const parsed = origin ? parseGitOrigin(origin) : null;
  if (parsed) return parsed;
  return { repoIdentifier: `local/${path.basename(repoRoot)}`, provider: LOCAL_PROVIDER };
}
