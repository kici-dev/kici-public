/**
 * SDK aliasing for development mode
 *
 * Enables automatic aliasing of @kici-dev/sdk imports to a local development repository when:
 * 1. sdkPath is configured in .kici/package.json
 * 2. Current project is NOT the kici development repo itself
 *
 * This allows developers to test SDK changes in real-time without publishing or manual linking.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@kici-dev/core';

/**
 * Get rolldown alias configuration for SDK development mode.
 *
 * Returns alias mapping if:
 * - sdkPath is configured in .kici/package.json
 * - Current project is NOT the kici repo itself
 * - SDK build exists at configured path
 *
 * @returns Alias config for rolldown (empty object if aliasing disabled)
 */
export async function getSdkAliasConfig(): Promise<Record<string, string>> {
  const basePath = await getSdkPathFromPackageJson();
  if (!basePath) {
    return {};
  }

  if (await isInKiciRepo()) {
    if (process.env.KICI_DEBUG === 'true') {
      logger.warn('[kici] SDK aliasing disabled: running inside kici development repo');
    }
    return {};
  }

  const sdkPath = resolveAndValidateSdkPath(basePath);
  if (!sdkPath) {
    return {};
  }

  logger.warn(
    `[kici] Development mode: using local SDK from ${path.dirname(path.dirname(sdkPath))}`,
  );

  return { '@kici-dev/sdk': sdkPath };
}

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
 * Resolve and validate the SDK dist path from a base kici repo path.
 *
 * @returns Absolute path to SDK dist/index.js, or null if not found
 */
function resolveAndValidateSdkPath(basePath: string): string | null {
  const sdkPath = path.resolve(basePath, 'packages/sdk/dist/index.js');

  if (!existsSync(sdkPath)) {
    logger.warn('[kici] sdkPath configured but SDK not found at path');
    logger.warn(`[kici] Expected: ${sdkPath}`);
    logger.warn('[kici] Hint: run "pnpm build" in the kici repo');
    return null;
  }

  if (process.env.KICI_DEBUG === 'true') {
    logger.warn(`[kici] SDK alias resolved to: ${sdkPath}`);
  }

  return sdkPath;
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
