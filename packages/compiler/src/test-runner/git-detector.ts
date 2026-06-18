/**
 * Auto-detect repository information from .git/config
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface RepoInfo {
  owner: string;
  name: string;
}

/**
 * Detect repository owner and name from .git/config
 * @param cwd - Working directory to search for .git/config
 * @returns Repository info or null if not a git repo or no origin
 */
export async function detectRepoFromGit(cwd = process.cwd()): Promise<RepoInfo | null> {
  try {
    const gitConfigPath = path.join(cwd, '.git', 'config');
    const config = await readFile(gitConfigPath, 'utf-8');

    // Parse [remote "origin"] url
    const remoteMatch = config.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m);
    if (!remoteMatch) return null;

    const url = remoteMatch[1].trim();

    // Handle SSH: git@github.com:owner/repo.git
    // Handle HTTPS: https://github.com/owner/repo.git
    const match = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?$/);
    if (!match) return null;

    return { owner: match[1], name: match[2] };
  } catch {
    // Not a git repo or no .git/config
    return null;
  }
}
