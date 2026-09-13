/**
 * SDK development-mode path resolution.
 *
 * Resolves a local @kici-dev/sdk checkout for IDE tsconfig `paths` mappings when:
 * 1. sdkPath is configured in .kici/package.json
 * 2. Current project is NOT the kici development repo itself
 *
 * This gives developers editor autocomplete against local SDK source without
 * publishing or manual linking.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Read sdkPath from .kici/package.json configuration.
 *
 * @returns Absolute path to SDK repo, or null if not configured
 */
async function getSdkPathFromPackageJson(): Promise<string | null> {
  try {
    // Read .kici/package.json from current working directory
    const pkgPath = path.resolve(process.cwd(), '.kici', 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { sdkPath?: string } };

    const sdkPath = pkg.kici?.sdkPath;
    if (!sdkPath) {
      return null;
    }

    // Convert to absolute path if relative
    return path.resolve(sdkPath);
  } catch {
    // .kici/package.json doesn't exist or can't be read
    return null;
  }
}

/**
 * Check if current project is the kici development repository.
 *
 * Checks if root package.json has kici.development flag set to true.
 *
 * @returns true if running inside kici repo
 */
async function isInKiciRepo(): Promise<boolean> {
  try {
    // Check if project root has kici.development flag
    // From .kici/ directory, root is ../package.json
    // But we're in the project root, so just check package.json
    const rootPkgPath = path.resolve(process.cwd(), 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { development?: boolean } };
    return pkg.kici?.development === true;
  } catch {
    return false;
  }
}

/**
 * Get TypeScript path mappings for IDE support.
 *
 * Returns path mapping configuration to include in tsconfig.json:
 * - Points @kici-dev/sdk to local source for autocomplete
 * - Only if sdkPath is configured and valid
 *
 * @returns TypeScript paths config, or null if not applicable
 */
export async function getTypeScriptPaths(): Promise<{ '@kici-dev/sdk': [string] } | null> {
  const basePath = await getSdkPathFromPackageJson();
  if (!basePath) {
    return null;
  }

  // Don't add path mapping if in kici repo itself
  if (await isInKiciRepo()) {
    return null;
  }

  // Point to SDK source for IDE autocomplete
  const sdkSourcePath = path.resolve(basePath, 'packages/sdk/src/index.ts');

  return {
    '@kici-dev/sdk': [sdkSourcePath],
  };
}
