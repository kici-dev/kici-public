import { writeFileSync } from 'node:fs';

/**
 * Reusable restore-on-exit safety net for publish scripts that temporarily
 * rewrite (pin) a package.json before publishing and restore it afterward.
 *
 * If the publish process is killed (deploy timeout, Ctrl-C, parent abort)
 * after the pin but before the in-band restore runs, the working-tree
 * manifest is left pinned — which then breaks a downstream container build's
 * `pnpm install --frozen-lockfile` against the `workspace:*` lockfile.
 * Registering each pinned file here binds it to `process.on('exit'|'SIGINT'|
 * 'SIGTERM')` so the original content is rewritten even on an unexpected exit.
 *
 * A shared module, so the chained `kici` publish wrapper gets the same
 * guarantee as the workspace publish.
 */

/** path -> original content. Files to restore on unexpected exit. */
const pending = new Map();
let handlersInstalled = false;

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', flushRestores);
  process.on('SIGINT', () => {
    flushRestores();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    flushRestores();
    process.exit(143);
  });
}

/** Register a file's original content for restore-on-exit, and pin-proof it. */
export function registerRestore(filePath, originalContent) {
  installHandlers();
  pending.set(filePath, originalContent);
}

/** Drop a file from the restore set (call after a normal in-band restore). */
export function unregisterRestore(filePath) {
  pending.delete(filePath);
}

/** Restore every still-registered file to its original content. */
export function flushRestores() {
  for (const [filePath, content] of pending) {
    try {
      writeFileSync(filePath, content, 'utf-8');
    } catch {
      // best effort — process may be exiting
    }
  }
  pending.clear();
}

/** Test-only: clear state + pretend handlers are not installed. */
export function __resetForTest() {
  pending.clear();
  handlersInstalled = false;
}
