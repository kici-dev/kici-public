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
});
