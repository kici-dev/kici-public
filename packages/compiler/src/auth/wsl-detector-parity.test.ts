import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

/**
 * On WSL, `isHeadless()` picks the browser (PKCE) flow and `open` launches the
 * *Windows* browser, both via `wsl-utils`; they agree only while both resolve
 * the SAME copy. An `open` bump with a non-overlapping `wsl-utils` range would
 * install two copies that still typecheck; this test is the only signal.
 */
describe('wsl-utils single-instance parity with `open`', () => {
  const require_ = createRequire(import.meta.url);

  it('resolves the same wsl-utils module as the `open` package does', () => {
    const openEntry = require_.resolve('open');
    const ours = realpathSync(require_.resolve('wsl-utils'));
    const theirs = realpathSync(createRequire(openEntry).resolve('wsl-utils'));

    expect(theirs).toBe(ours);
  });
});
