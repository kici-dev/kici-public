import { describe, it, expect, vi } from 'vitest';
import { restageAgent } from './restage-agent.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const REACH = { agentId: 'box-1', address: '10.0.0.1', sshUser: 'root', sshPort: 22 };
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----';
const SHA = 'a'.repeat(64);
const RESTART = {
  stop: 'systemctl --user stop kici-agent',
  start: 'systemctl --user start kici-agent',
};

/** Return the remote command an `ssh` invocation carries (its last argv token). */
function remoteCmd(args: string[]): string {
  return args[args.length - 1] ?? '';
}

/**
 * Build a spawn boundary that dispatches on the remote command. `currentVersion`
 * is what `readlink` reports; `failExtract` makes the on-box stage fail.
 */
function makeSpawn(opts: { currentVersion?: string | null; failExtract?: boolean } = {}): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[]; cmd: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cmd: string }> = [];
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\nSSH_AGENT_PID=1;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args) => {
    const cmd = command === 'ssh' ? remoteCmd(args) : '';
    calls.push({ command, args, cmd });
    if (command === 'ssh-agent' && args[0] !== '-k') return agentStart;
    if (command === 'ssh' && cmd.includes('readlink')) {
      const v = opts.currentVersion;
      return { exitCode: 0, stdout: v ? `kici-agent-${v}\n` : '\n', stderr: '' };
    }
    if (command === 'ssh' && cmd.includes('sha256sum -c')) {
      return opts.failExtract
        ? { exitCode: 1, stdout: '', stderr: 'sha256sum: FAILED' }
        : { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { spawnFn, calls };
}

const opts = (over = {}) => ({
  platform: 'linux-x64' as const,
  version: '2.0.0',
  delivery: { mode: 's3-direct' as const, presignedUrl: 'https://c/p.tgz', sha256: SHA },
  restart: RESTART,
  ...over,
});

describe('restageAgent', () => {
  it('stages the target version, swaps the install, and drains + restarts', async () => {
    const { spawnFn, calls } = makeSpawn({ currentVersion: '1.0.0' });
    const res = await restageAgent(REACH, KEY, opts(), { spawnFn });
    expect(res.restaged).toBe(true);

    // Staged into the version-keyed dir.
    const stage = calls.find((c) => c.cmd.includes('sha256sum -c'));
    expect(stage?.cmd).toContain('kici-agent-2.0.0');
    // Atomic folder-anchored swap to the target version.
    const swap = calls.find((c) => c.cmd.includes('ln -sfn'));
    expect(swap?.cmd).toContain('kici-agent-2.0.0');
    expect(swap?.cmd).toContain('mv -T');
    // Drain then restart, in order.
    const stopIdx = calls.findIndex((c) => c.cmd.includes(RESTART.stop));
    const startIdx = calls.findIndex((c) => c.cmd.includes(RESTART.start));
    expect(stopIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  it('is a no-op when the host is already on the target version', async () => {
    const { spawnFn, calls } = makeSpawn({ currentVersion: '2.0.0' });
    const res = await restageAgent(REACH, KEY, opts(), { spawnFn });
    expect(res.restaged).toBe(false);
    // No stage, no swap, no restart.
    expect(calls.some((c) => c.cmd.includes('sha256sum -c'))).toBe(false);
    expect(calls.some((c) => c.cmd.includes('ln -sfn'))).toBe(false);
    expect(calls.some((c) => c.cmd.includes(RESTART.stop))).toBe(false);
  });

  it('aborts BEFORE the swap when the stage fails (no half-upgrade)', async () => {
    const { spawnFn, calls } = makeSpawn({ currentVersion: '1.0.0', failExtract: true });
    await expect(restageAgent(REACH, KEY, opts(), { spawnFn })).rejects.toThrow(
      /extract|verify|failed/i,
    );
    // The swap + restart never ran.
    expect(calls.some((c) => c.cmd.includes('ln -sfn'))).toBe(false);
    expect(calls.some((c) => c.cmd.includes(RESTART.stop))).toBe(false);
  });
});
