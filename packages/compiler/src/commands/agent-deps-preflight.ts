/**
 * The check `kici compile`, `kici run remote`, an isolated `kici run --local`
 * and `kici doctor` share. Every agent installs `.kici/` dependencies from
 * `.kici/package.json` and from nothing else, so a `.kici/` with workflows but
 * no `.kici/package.json` cannot resolve `@kici-dev/sdk` on an agent. It works
 * only where an enclosing node_modules already has the SDK, which is the case
 * for an in-place local run.
 */
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';

/** The command that adds the missing manifest in a workspace. */
export const MISSING_KICI_MANIFEST_FIX = 'kici init --workspace';

export const MISSING_KICI_MANIFEST_MESSAGE =
  '.kici/ has workflows but no .kici/package.json, so @kici-dev/sdk does not resolve on an agent. ' +
  `Run \`${MISSING_KICI_MANIFEST_FIX}\` in a workspace, or add a .kici/package.json that declares @kici-dev/sdk.`;

/** True when `kiciDir/workflows` holds a `*.ts` workflow and `kiciDir/package.json` is absent. */
export async function kiciDirNeedsManifest(kiciDir: string): Promise<boolean> {
  try {
    await access(path.join(kiciDir, 'package.json'));
    return false;
  } catch {
    // No manifest: the answer depends on whether there are workflows.
  }
  try {
    const entries = await readdir(path.join(kiciDir, 'workflows'), { withFileTypes: true });
    return entries.some((e) => e.isFile() && e.name.endsWith('.ts'));
  } catch {
    return false;
  }
}

/** Print the warning when `kiciDir` needs a manifest. Returns whether it printed. */
export async function warnIfKiciManifestMissing(kiciDir: string): Promise<boolean> {
  if (!(await kiciDirNeedsManifest(kiciDir))) return false;
  logger.warn(pc.yellow(MISSING_KICI_MANIFEST_MESSAGE));
  return true;
}
