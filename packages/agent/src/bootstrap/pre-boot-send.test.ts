import { describe, it, expect, vi } from 'vitest';
import { preBootSend } from './pre-boot-send.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const MATERIAL = {
  reach: { agentId: 'box-00007', address: '10.0.0.7', sshUser: 'root', sshPort: 22 },
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----',
  input: 'LUKS-PASSPHRASE',
  port: 2222,
  command: 'cryptroot-unlock',
};

function makeSpawn(): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin });
    if (command === 'ssh-agent' && args[0] === '-s') return agentStart;
    // The unlock session drops — model a non-zero exit; preBootSend ignores it.
    if (command === 'ssh') return { exitCode: 255, stdout: '', stderr: 'connection closed' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { spawnFn, calls };
}

describe('preBootSend (agent-side)', () => {
  it('pipes the resolved input to the dropbear port with accept-new and does not throw on session drop', async () => {
    const transport = vi.fn(async () => MATERIAL);
    const { spawnFn, calls } = makeSpawn();

    await expect(
      preBootSend(transport, 'box-00007', { inputSecret: 'prod/luks/box-00007' }, { spawnFn }),
    ).resolves.toBeUndefined();

    expect(transport).toHaveBeenCalledWith('kici.preBootSend', {
      targetAgentId: 'box-00007',
      inputSecret: 'prod/luks/box-00007',
    });

    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.stdin).toBe('LUKS-PASSPHRASE');
    expect(ssh?.args[ssh.args.indexOf('-p') + 1]).toBe('2222');
    expect(ssh?.args.join(' ')).toContain('StrictHostKeyChecking=accept-new');
    expect(ssh?.args).toContain('cryptroot-unlock');
  });

  it('forwards an explicit port and command through to the transport', async () => {
    const transport = vi.fn(async () => ({ ...MATERIAL, port: 22, command: 'custom' }));
    const { spawnFn } = makeSpawn();
    await preBootSend(
      transport,
      'box-00007',
      { inputSecret: 'prod/luks/box-00007', port: 22, command: 'custom' },
      { spawnFn },
    );
    expect(transport).toHaveBeenCalledWith('kici.preBootSend', {
      targetAgentId: 'box-00007',
      inputSecret: 'prod/luks/box-00007',
      port: 22,
      command: 'custom',
    });
  });
});
