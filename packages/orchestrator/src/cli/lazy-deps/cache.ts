/** Cache directory of the lazy dependencies. */

import fs from 'node:fs';
import { getCacheDir } from '../service/platform-detect.js';

export function getCacheBasePath(): string {
  return getCacheDir();
}

export function cleanCache(cacheDir: string): void {
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}
