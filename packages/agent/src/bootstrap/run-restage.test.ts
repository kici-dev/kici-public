import { describe, it, expect, vi } from 'vitest';
import { runRestage } from './run-restage.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const SHA = 'a'.repeat(64);
const material = {
  reach: { agentId: 'box-9', address: '10.0.0.9', sshUser: 'root', sshPort: 22 },
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END-----',
  version: '2.0.0',
  restart: {
    stop: 'systemctl --user stop kici-agent || true',
    start: 'systemctl --user start kici-agent',
  },
};

/** Spawn boundary: uname → linux-x64, readlink → current version, everything else ok. */
function makeSpawn(currentVersion = '1.0.0'): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; cmd: string }>;
} {
  const calls: Array<{ command: string; cmd: string }> = [];
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\nSSH_AGENT_PID=1;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args) => {
    const cmd = command === 'ssh' ? (args[args.length - 1] ?? '') : '';
    calls.push({ command, cmd });
    if (command === 'ssh-agent' && args[0] !== '-k') return agentStart;
    if (cmd.includes('uname')) return { exitCode: 0, stdout: 'Linux x86_64\nglibc\n', stderr: '' };
    if (cmd.includes('readlink'))
      return { exitCode: 0, stdout: `kici-agent-${currentVersion}\n`, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { spawnFn, calls };
}

describe('runRestage', () => {
  it('s3-direct: probes platform, presigns, then re-stages + restarts', async () => {
    const { spawnFn, calls } = makeSpawn();
    const transport = vi.fn(async (method: string) => {
      if (method === 'kici.restageAgent') return { ...material, deliveryMode: 's3-direct' };
      if (method === 'kici.presignAgentPackage') return { url: 'https://c/p.tgz', sha256: SHA };
      throw new Error(`unexpected ${method}`);
    });
    const res = await runRestage(transport, 'box-9', { spawnFn });
    expect(res.restaged).toBe(true);
    // Presign was requested for the PROBED platform.
    expect(transport).toHaveBeenCalledWith('kici.presignAgentPackage', {
      targetAgentId: 'box-9',
      platform: 'linux-x64',
    });
    // The box curled the presigned URL (s3-direct — no ops-agent transit).
    expect(
      calls.some((c) => c.cmd.includes('curl -fsSL') && c.cmd.includes('kici-agent-2.0.0')),
    ).toBe(true);
  });

  it('ssh-push: no presign; stages via the ops agent', async () => {
    const { spawnFn } = makeSpawn();
    const source = { resolve: vi.fn(async () => ({ tarballPath: '/tmp/p.tgz', sha256: SHA })) };
    const transport = vi.fn(async (method: string) => {
      if (method === 'kici.restageAgent') return { ...material, deliveryMode: 'ssh-push' };
      throw new Error(`unexpected ${method}`);
    });
    const res = await runRestage(transport, 'box-9', {
      spawnFn,
      payloadSource: source,
      hashLocalFile: vi.fn(async () => SHA),
    });
    expect(res.restaged).toBe(true);
    expect(transport).not.toHaveBeenCalledWith('kici.presignAgentPackage', expect.anything());
  });

  it('is a no-op when the host already runs the target version', async () => {
    const { spawnFn } = makeSpawn('2.0.0');
    const transport = vi.fn(async (method: string) => {
      if (method === 'kici.restageAgent') return { ...material, deliveryMode: 's3-direct' };
      if (method === 'kici.presignAgentPackage') return { url: 'https://c/p.tgz', sha256: SHA };
      throw new Error(`unexpected ${method}`);
    });
    const res = await runRestage(transport, 'box-9', { spawnFn });
    // restageAgent's readlink sees the target already installed → no stage/swap.
    expect(res.restaged).toBe(false);
  });

  it('throws on incomplete material', async () => {
    const { spawnFn } = makeSpawn();
    const transport = vi.fn(async () => ({ version: '2.0.0' }));
    await expect(runRestage(transport, 'box-9', { spawnFn })).rejects.toThrow(/incomplete/i);
  });
});
