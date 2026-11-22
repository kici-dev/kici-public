import { beforeEach, describe, expect, it, vi } from 'vitest';

// The default command runner is only reachable through the exported helpers,
// so this file mocks the spawn and the binary resolver and drives it through
// `resolveHostIface`, the smallest one.
const spawn = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolve: vi.fn((name: string) => `/resolved/${name}`),
}));
vi.mock('node:child_process', () => ({ execFile: spawn.execFile }));
vi.mock('@kici-dev/shared/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared/net')>()),
  resolveSystemBinary: spawn.resolve,
}));
const mockExecFile = spawn.execFile;
const mockResolve = spawn.resolve;

const { resolveHostIface } = await import('./host-network.js');

beforeEach(() => {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (e: null, r: unknown) => void) =>
      cb(null, { stdout: '[{"dev":"enp0s31f6"}]' }),
  );
});

describe('default host-network runner', () => {
  it('spawns the resolved binary path when it runs without sudo', async () => {
    // fails-when: the runner spawns the bare name — `spawn ip ENOENT` (or nft,
    // sysctl, iptables) on a non-root host whose PATH leaves out /usr/sbin.
    expect(await resolveHostIface()).toBe('enp0s31f6');
    expect(mockResolve).toHaveBeenCalledWith('ip');
    expect(mockExecFile.mock.calls[0]!.slice(0, 2)).toEqual([
      '/resolved/ip',
      ['-j', 'route', 'show', 'default'],
    ]);
  });

  it('keeps the bare name behind sudo, which searches its own secure_path', async () => {
    // breaks-if-wrong: a sudoers rule names the binary sudo resolves; the
    // runner must not swap in a path of its own there.
    expect(await resolveHostIface({ requireSudo: true })).toBe('enp0s31f6');
    expect(mockExecFile.mock.calls[0]!.slice(0, 2)).toEqual([
      'sudo',
      ['-n', 'ip', '-j', 'route', 'show', 'default'],
    ]);
  });
});
