import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

/**
 * `isHeadless()` decides whether `kici login` picks the browser (PKCE) flow on
 * WSL; `open` decides whether it actually launches the *Windows* browser. Both
 * answer that question from `wsl-utils` (`isWsl` + `canAccessPowerShell`), so
 * the two agree only as long as they resolve to the SAME copy of the module.
 *
 * A future `open` bump whose `wsl-utils` range stops overlapping ours would
 * install two copies and silently reopen the divergence this consolidation
 * closed — with no other signal, since both copies still typecheck and both
 * still export the same names. This test is that signal.
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
