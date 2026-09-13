import { describe, it, expect, vi } from 'vitest';
import { parseUname, probeTargetPlatform } from './probe-platform.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const REACH = { agentId: 'box-1', address: '10.0.0.1', sshUser: 'root', sshPort: 22 };
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----';

describe('parseUname', () => {
  it('maps Linux x86_64 (glibc) → linux-x64', () => {
    expect(parseUname('Linux x86_64\nldd (GNU libc) 2.36')).toBe('linux-x64');
  });
  it('maps Linux aarch64 (glibc) → linux-arm64', () => {
    expect(parseUname('Linux aarch64\nldd (GNU libc) 2.36')).toBe('linux-arm64');
  });
  it('throws naming musl when the libc is musl', () => {
    expect(() => parseUname('Linux x86_64\nmusl libc (x86_64)')).toThrow(/musl/i);
  });
  it('throws naming Darwin for non-Linux', () => {
    expect(() => parseUname('Darwin arm64\n')).toThrow(/Darwin/);
  });
  it('throws naming the arch for an unknown arch', () => {
    expect(() => parseUname('Linux mips\nldd (GNU libc) 2.36')).toThrow(/mips/);
  });
});

/** A spawn stub that returns the ssh-agent boot lines, then the probe stdout. */
function makeSpawn(probeStdout: string): { spawnFn: SpawnFn } {
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\nSSH_AGENT_PID=1;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args) => {
    if (command === 'ssh-agent' && args[0] !== '-k') return agentStart;
    if (command === 'ssh') return { exitCode: 0, stdout: probeStdout, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { spawnFn };
}

describe('probeTargetPlatform', () => {
  it('runs one SSH probe and maps the uname output', async () => {
    const { spawnFn } = makeSpawn('Linux aarch64\nldd (GNU libc) 2.36');
    const platform = await probeTargetPlatform(REACH, KEY, { spawnFn });
    expect(platform).toBe('linux-arm64');
  });

  it('propagates the parse throw for an unsupported target', async () => {
    const { spawnFn } = makeSpawn('Darwin arm64\n');
    await expect(probeTargetPlatform(REACH, KEY, { spawnFn })).rejects.toThrow(/Darwin/);
  });
});
