import { mkdtempSync } from 'node:fs';
import path from 'node:path';

import { kiciTmpBase } from '@kici-dev/core/tmp';

/**
 * Base directory for KiCI-created temp files. Honors the `KICI_TMPDIR` env var
 * (creating it if it does not yet exist) so an operator can route KiCI's temp
 * footprint onto a volume with room; falls back to the OS temp dir otherwise.
 * Server-side only (Node fs/os) — do NOT import from browser-bundled code.
 *
 * Delegates to `@kici-dev/core/tmp`'s resolver so `KICI_TMPDIR` is read in
 * exactly one place across the codebase.
 */
export { kiciTmpBase };

/** Create a fresh unique temp dir under {@link kiciTmpBase} with `prefix`. */
export function kiciMkdtemp(prefix: string): string {
  return mkdtempSync(path.join(kiciTmpBase(), prefix));
}
