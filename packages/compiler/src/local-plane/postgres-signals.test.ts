import { describe, it, expect } from 'vitest';

/**
 * Loading the CLI commands must not take over Ctrl-C. embedded-postgres
 * installs a process-wide SIGINT handler that exits at once when it is
 * imported, so it is imported only when the plane starts its cluster.
 */
describe('signal handlers on module load', () => {
  it('loading the commands barrel installs no SIGINT or SIGTERM handler', async () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };

    // fails-when: postgres.ts imports embedded-postgres at module load, which
    // registers its exit hook and ends `kici run remote` on Ctrl-C before the
    // cancel request is sent
    await import('../commands/index.js');

    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);

    // breaks-if-wrong: the probe must see the handler embedded-postgres installs,
    // or the assertion above passes whatever the barrel imports
    await import('embedded-postgres');
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(before.int);
  }, 60_000);
});
