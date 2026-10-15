/**
 * Import first in a test file, before the module under test:
 *   import '<relative>/__test-helpers__/shared-mocks.js';
 * It silences the logger and keeps every other `@kici-dev/shared` export.
 */
import { vi } from 'vitest';

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const { withSilentLogger } = await import('@kici-dev/test-support/logger-mock');
  return withSilentLogger(await importOriginal<typeof import('@kici-dev/shared')>());
});
