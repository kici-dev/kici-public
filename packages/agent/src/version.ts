/**
 * Read the agent's own package version from disk.
 *
 * Walks up from this module's location until it finds a package.json whose
 * name is '@kici-dev/agent'. This is robust to the agent's bundled dist layout
 * (build-service.mjs emits dist/index.js / dist/server.js, so a fixed relative
 * depth would be wrong). Returns null when it can't be resolved so the
 * agent.register message simply omits the field rather than failing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readAgentVersion(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@kici-dev/agent' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}
