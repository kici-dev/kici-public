import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { API_KEY_DEPRECATED_MESSAGE, registerApiKeyCommands } from './api-key.js';

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

afterEach(() => vi.restoreAllMocks());

async function run(args: string[]) {
  const getClient = vi.fn();
  const program = new Command().exitOverride();
  registerApiKeyCommands(program, getClient);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitError(code as number);
  });
  const err = await program.parseAsync(['node', 'kici-admin', ...args]).catch((e: unknown) => e);
  return {
    getClient,
    err,
    stderr: stderr.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

describe('kici-admin api-key (deprecated)', () => {
  it.each([
    [['api-key', 'create', '--label', 'x']],
    [['api-key', 'add-routing-key', 'id-1', 'github:*']],
  ])('%j exits 1 pointing at kici-admin token create', async (args) => {
    const { getClient, err, stderr } = await run(args);
    // fails-when: the command still calls the unserved /api/v1/api-keys route
    expect(getClient).not.toHaveBeenCalled();
    expect((err as ExitError).code).toBe(1);
    expect(stderr).toContain(
      'kici-admin token create <label> --role admin --subject <who> --expires <duration>',
    );
    expect(stderr).toContain('v1.0.0');
  });

  it('names the replacement in the message', () => {
    expect(API_KEY_DEPRECATED_MESSAGE).toContain('kici-admin token create');
  });
});
