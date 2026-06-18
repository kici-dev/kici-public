/**
 * Startup validation for required external tools and binaries.
 *
 * Used by the orchestrator (scaler backends) and agent to verify that all
 * required system tools are available before accepting work. Missing tools
 * cause a clear fatal error at startup rather than cryptic runtime failures.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * A single tool requirement declaration.
 *
 * - `path-binary`: a binary that must be found on PATH (e.g., 'git', 'ip', 'bash')
 * - `any-path-binary`: at least one of `names` must be found on PATH (e.g.,
 *   'docker' OR 'podman' for the container scaler runtime)
 * - `file-access`: an absolute path that must exist with the specified access mode
 */
export type ToolRequirement =
  | { type: 'path-binary'; name: string; reason: string }
  | { type: 'any-path-binary'; names: string[]; reason: string }
  | { type: 'file-access'; path: string; mode: 'executable' | 'readable'; reason: string };

/**
 * Validate a list of tool requirements.
 *
 * Deduplicates requirements, checks each one, and returns ALL errors
 * (not fail-on-first) so the operator sees every missing tool at once.
 *
 * @returns Array of error messages. Empty array means all tools are available.
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
 * Check if a binary is available on PATH.
 *
 * Walks the directories in `process.env.PATH` and tests each candidate via
 * `accessSync(..., X_OK)`. Pure-Node implementation — no `which` / `where`
 * dependency, so the check works on minimal base images (Docker Hardened
 * Images, distroless, alpine variants) that strip the `which` binary even
 * when `debianutils` is technically installed.
 *
 * Windows: tries `name` + `name.exe`/`.cmd`/`.bat`/`.com` extensions (mirrors
 * PATHEXT defaults) so `git` resolves to `git.exe` without the caller having
 * to pre-suffix.
 */
function isBinaryOnPath(name: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const dirs = pathEnv.split(delimiter);
  // Windows: probe the same suffix set Windows itself defaults to on a
  // fresh install (cmd.exe's PATHEXT default minus the registry-only
  // entries .VBS / .WSF / .JS that aren't directly executable from
  // process spawn). Hardcoded rather than reading the Windows PATHEXT
  // variable because the env-var lint allowlist only permits KICI_*/OS-SDK
  // names and PATHEXT isn't on that allowlist; the hardcoded set covers
  // every real shipping case (no operator has ever needed a custom
  // PATHEXT for a KiCI tool check).
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
