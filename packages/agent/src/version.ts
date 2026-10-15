/**
 * Walk up to the `@kici-dev/agent` package.json: the bundled dist layout
 * (build-service.mjs) rules out a fixed relative depth. Null when unresolved, so
 * agent.register omits the field rather than failing.
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
