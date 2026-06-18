/**
 * Cache directory management for lazy dependencies.
 *
 * Provides cache path resolution and cleanup.
 */

import fs from 'node:fs';
import { getCacheDir } from '../service/platform-detect.js';

/**
 * Get the base cache directory path for lazy dependencies.
 * Delegates to platform-detect's getCacheDir() for platform-appropriate paths.
 */
export function getCacheBasePath(): string {
  return getCacheDir();
}

/**
 * Remove all cached dependencies.
 *
 * @param cacheDir - Cache directory to clean (from getCacheBasePath())
 */
export function cleanCache(cacheDir: string): void {
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}
