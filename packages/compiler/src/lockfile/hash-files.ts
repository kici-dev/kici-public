import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * Resolve hashFiles paths and globs (git-root-relative) into a deterministic
 * digest: sorted paths, each followed by "\n" and its content. It feeds the
 * content hash, so the workflow cache invalidates when these files change.
 * Null only when no patterns are given.
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
      // An unreadable file contributes its path with empty content.
      parts.push(`${rel}\n`);
    }
  }

  return {
    assetDigest: parts.join(''),
    resolvedPaths: resolved,
  };
}
