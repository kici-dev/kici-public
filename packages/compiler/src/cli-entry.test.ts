import { describe, it, expect, vi, afterEach } from 'vitest';

const guard = vi.hoisted(() => vi.fn());
vi.mock('./cli-unsettled-guard.js', () => ({ guardUnsettledExit: guard }));

import { runCli } from './cli.js';

describe('runCli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    guard.mockReset();
  });

  it('guards the promise that parsing and running the command returns', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // fails-when: runCli parses synchronously and nothing guards the action's promise
    runCli(['node', 'kici', '--version']);

    expect(guard).toHaveBeenCalledTimes(1);
    const work = guard.mock.calls[0][0] as Promise<unknown>;
    expect(work).toBeInstanceOf(Promise);
    // breaks-if-wrong: a commander exit (here --version) must still exit 0 through the handler
    await work.catch(() => undefined);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  // fails-when: a Platform's newer-client refusal surfaces as a stack trace, not its message
  it('prints the Platform message and exits 1 when a Platform refuses a newer CLI', async () => {
    const message = 'This component is newer than the KiCI Platform it connects to.';
    vi.resetModules();
    vi.doMock('./commands/index.js', async (importOriginal) => {
      const { ClientNewerThanPlatformError } = await import('./remote/platform-fetch.js');
      return {
        ...(await importOriginal<object>()),
        orgListCommand: async () => {
          throw new ClientNewerThanPlatformError(message);
        },
      };
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { runCli: fresh } = await import('./cli.js');
      fresh(['node', 'kici', 'org', 'list']);
      await (guard.mock.calls[0][0] as Promise<unknown>).catch(() => undefined);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(message);
    } finally {
      vi.doUnmock('./commands/index.js');
    }
  });
});
