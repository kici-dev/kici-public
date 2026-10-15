import { execSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

/** Git hosts whose origin URL maps to a real `owner/repo` and web link. */
export const RecognizedProvider = z.enum(['github', 'gitlab', 'bitbucket']);
export type RecognizedProvider = z.infer<typeof RecognizedProvider>;

/** Keyed by canonical public hostname. */
const HOST_PROVIDER: Record<string, RecognizedProvider> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

/** Stamped when no recognized git origin exists. */
export const LOCAL_PROVIDER = 'local';

/** Handles scp-style, `ssh://` and `https://` remotes; null for an unrecognized host or bad input. */
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
 * The repo identity stamped on a `kici run remote` run: the real `owner/repo`
 * for a recognized origin, so the dashboard can link it, else `local/<basename>`.
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
