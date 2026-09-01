import { describe, it, expect, vi } from 'vitest';
import { runHelperMain } from './credential-helper-bin.js';

const STDIN = 'protocol=https\nhost=github.com\npath=kici-dev/tester.git\n\n';

describe('runHelperMain', () => {
  it('answers a get by forwarding to the agent socket', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ kind: 'basic', user: 'x-access-token', secret: 'ghs_x' });
    const out = await runHelperMain(['get'], STDIN, { send });
    expect(out).toBe('username=x-access-token\npassword=ghs_x\n');
  });

  it('is a silent no-op for store and erase — we persist nothing', async () => {
    const send = vi.fn();
    expect(await runHelperMain(['store'], STDIN, { send })).toBe('');
    expect(await runHelperMain(['erase'], STDIN, { send })).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('returns empty rather than throwing when the agent is unreachable', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await runHelperMain(['get'], STDIN, { send })).toBe('');
  });

  it('returns empty when the broker has no credential for the repo', async () => {
    const send = vi.fn().mockResolvedValue(null);
    expect(await runHelperMain(['get'], STDIN, { send })).toBe('');
  });

  it('never writes the secret anywhere but the returned reply', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'basic', secret: 'ghs_secret' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runHelperMain(['get'], STDIN, { send });
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it('forwards the parsed query so the agent can tell repositories apart', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'basic', secret: 's' });
    await runHelperMain(['get'], STDIN, { send });
    expect(send).toHaveBeenCalledWith({
      protocol: 'https',
      host: 'github.com',
      path: 'kici-dev/tester.git',
    });
  });
});
