import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface RepoInfo {
  owner: string;
  name: string;
}

/**
 * Reads the GitHub owner and name of `origin` from `<cwd>/.git/config`; null
 * when there is no config, no origin, or a non-GitHub URL.
 */
export async function detectRepoFromGit(cwd = process.cwd()): Promise<RepoInfo | null> {
  try {
    const gitConfigPath = path.join(cwd, '.git', 'config');
    const config = await readFile(gitConfigPath, 'utf-8');

    const remoteMatch = config.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m);
    if (!remoteMatch) return null;

    const url = remoteMatch[1].trim();

    // SSH git@github.com:owner/repo.git or HTTPS https://github.com/owner/repo.git
    const match = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?$/);
    if (!match) return null;

    return { owner: match[1], name: match[2] };
  } catch {
    return null;
  }
}

/** The checked-out branch of `repoRoot`, or undefined on a detached `HEAD` or outside git. */
export function detectCurrentBranch(repoRoot: string): string | undefined {
  try {
    // The full ref, not `--short`: a tag with the same name makes the short form `heads/<name>`.
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  } catch {
    return undefined;
  }
}
