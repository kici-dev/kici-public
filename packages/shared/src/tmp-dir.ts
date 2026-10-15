import { mkdtempSync } from 'node:fs';
import path from 'node:path';

import { kiciTmpBase } from '@kici-dev/core/tmp';

/**
 * Base directory for KiCI temp files: `KICI_TMPDIR` (created if missing), else
 * the OS temp dir. Re-exports `@kici-dev/core/tmp`'s resolver, the only read of
 * `KICI_TMPDIR`. Server-side only (Node fs/os) — do NOT import from
 * browser-bundled code.
 */
export { kiciTmpBase };

/** Create a fresh unique temp dir under {@link kiciTmpBase} with `prefix`. */
export function kiciMkdtemp(prefix: string): string {
  return mkdtempSync(path.join(kiciTmpBase(), prefix));
}
