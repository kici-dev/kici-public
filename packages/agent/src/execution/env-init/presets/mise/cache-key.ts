import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** mise config files, in the fixed order they feed the content hash. */
const MISE_CONFIG_FILES = ['mise.toml', '.mise.toml', '.tool-versions'] as const;

/**
 * The default mise cache key: a hash of whichever {@link MISE_CONFIG_FILES}
 * exist under `cloneRoot`, or `mise-noconfig` when none do.
 */
export async function miseCacheKey(cloneRoot: string): Promise<string> {
  const hash = createHash('sha256');
  let found = false;
  for (const name of MISE_CONFIG_FILES) {
    try {
      const buf = await readFile(join(cloneRoot, name));
      hash.update(name);
      hash.update(buf);
      found = true;
    } catch {
      // absent
    }
  }
  if (!found) return 'mise-noconfig';
  return `mise-${hash.digest('hex').slice(0, 16)}`;
}
