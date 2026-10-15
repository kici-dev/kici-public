/**
 * Map @kici-dev/sdk to a local checkout in IDE tsconfig `paths` — editor
 * autocomplete against local SDK source without publishing or linking — when
 * `.kici/package.json` sets `kici.sdkPath` and the project is NOT the kici
 * development repo itself.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Absolute `kici.sdkPath` from `.kici/package.json` (relative to CWD), or null. */
async function getSdkPathFromPackageJson(): Promise<string | null> {
  try {
    const pkgPath = path.resolve(process.cwd(), '.kici', 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { sdkPath?: string } };

    const sdkPath = pkg.kici?.sdkPath;
    if (!sdkPath) {
      return null;
    }

    return path.resolve(sdkPath);
  } catch {
    // Missing or unreadable.
    return null;
  }
}

/** The kici development repo sets `kici.development: true` in the CWD's package.json. */
async function isInKiciRepo(): Promise<boolean> {
  try {
    const rootPkgPath = path.resolve(process.cwd(), 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { development?: boolean } };
    return pkg.kici?.development === true;
  } catch {
    return false;
  }
}

/** tsconfig `paths` pointing @kici-dev/sdk at local source, or null when not applicable. */
export async function getTypeScriptPaths(): Promise<{ '@kici-dev/sdk': [string] } | null> {
  const basePath = await getSdkPathFromPackageJson();
  if (!basePath) {
    return null;
  }

  if (await isInKiciRepo()) {
    return null;
  }

  const sdkSourcePath = path.resolve(basePath, 'packages/sdk/src/index.ts');

  return {
    '@kici-dev/sdk': [sdkSourcePath],
  };
}
