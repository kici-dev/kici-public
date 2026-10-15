/**
 * Startup validation of required system tools for the orchestrator (scaler
 * backends) and agent: a missing tool is a clear fatal error at startup, not a
 * cryptic runtime failure.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * `path-binary` must be on PATH; `any-path-binary` needs at least one of
 * `names` on PATH (e.g. 'docker' OR 'podman'); `file-access` is an absolute
 * path that must exist with `mode`.
 */
export type ToolRequirement =
  | { type: 'path-binary'; name: string; reason: string }
  | { type: 'any-path-binary'; names: string[]; reason: string }
  | { type: 'file-access'; path: string; mode: 'executable' | 'readable'; reason: string };

/**
 * Deduplicates requirements and returns ALL errors (not fail-on-first), so the
 * operator sees every missing tool at once. Empty means all are available.
 */
export function validateRequiredTools(requirements: ToolRequirement[]): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];

  for (const req of requirements) {
    let key: string;
    if (req.type === 'path-binary') key = `path:${req.name}`;
    else if (req.type === 'any-path-binary') key = `any:${req.names.join(',')}`;
    else key = `file:${req.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (req.type === 'path-binary') {
      if (!isBinaryOnPath(req.name)) {
        errors.push(`'${req.name}' not found on PATH — ${req.reason}`);
      }
    } else if (req.type === 'any-path-binary') {
      if (!req.names.some((name) => isBinaryOnPath(name))) {
        const list = req.names.map((n) => `'${n}'`).join(' or ');
        errors.push(`none of ${list} found on PATH — ${req.reason}`);
      }
    } else {
      const mode = req.mode === 'executable' ? constants.X_OK : constants.R_OK;
      try {
        accessSync(req.path, mode);
      } catch {
        const modeLabel = req.mode === 'executable' ? 'executable' : 'readable';
        errors.push(`'${req.path}' not ${modeLabel} — ${req.reason}`);
      }
    }
  }

  return errors;
}

/**
 * Pure-Node PATH walk (`accessSync(..., X_OK)`), with no `which` / `where`
 * dependency: minimal base images (Docker Hardened Images, distroless, alpine)
 * strip `which` even when `debianutils` is installed.
 */
function isBinaryOnPath(name: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const dirs = pathEnv.split(delimiter);
  // Windows: cmd.exe's default PATHEXT minus .VBS / .WSF / .JS (not directly
  // spawnable), so `git` resolves to `git.exe`. Hardcoded because the env-var
  // lint allowlist does not permit PATHEXT; no operator has needed a custom one.
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // not here, keep walking
      }
    }
  }
  return false;
}
