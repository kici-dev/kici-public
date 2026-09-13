import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * Resolve hashFiles patterns (paths and globs) relative to git root and build a deterministic
 * digest string: sorted resolved paths, each followed by "\n" and file content.
 * Used as input to the content hash so workflow cache invalidates when these files change.
 *
 * @param gitRoot - Absolute path to git repository root
 * @param patterns - Paths or glob patterns relative to repo root (e.g. ["config.json", "scripts/*.sh"])
 * @returns Object with digest string and list of resolved paths (relative to git root), or null if no patterns or resolution fails
 */
export function resolveHashFiles(
  gitRoot: string,
  patterns: string[],
): { assetDigest: string; resolvedPaths: string[] } | null {
  if (patterns.length === 0) return null;

  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const pattern of patterns) {
    const matches = fg.sync(pattern, {
      cwd: gitRoot,
      absolute: false,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
    for (const p of matches) {
      const normalized = path.normalize(p).replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      resolved.push(normalized);
    }
  }

  resolved.sort();

  const parts: string[] = [];
  for (const rel of resolved) {
    try {
      const content = readFileSync(path.join(gitRoot, rel), 'utf-8');
      parts.push(`${rel}\n${content}`);
    } catch {
      // Skip files that can't be read (e.g. missing); consistent with "no content" affecting hash
      parts.push(`${rel}\n`);
    }
  }

  return {
    assetDigest: parts.join(''),
    resolvedPaths: resolved,
  };
}
