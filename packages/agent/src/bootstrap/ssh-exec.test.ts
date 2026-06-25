import { describe, expect, it, vi } from 'vitest';
import { sshExec, sshPush, type SpawnFn, type SshResult } from './ssh-exec.js';
import type { HostReach } from './reach.js';

const reach: HostReach = {
  agentId: 'box-00007',
  address: '10.0.0.7',
  sshUser: 'root',
  sshPort: 22,
};

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';

/** Record every spawn call; return canned results per command. */
function makeSpawn(results: Partial<Record<string, SshResult>> = {}): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const ok: SshResult = { exitCode: 0, stdout: '', stderr: '' };
  const agentStart: SshResult = {
    exitCode: 0,
    stdout:
      'SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin });
    if (command === 'ssh-agent' && args[0] === '-s') return agentStart;
    return results[command] ?? ok;
  });
  return { spawnFn, calls };
}

describe('sshExec', () => {
  it('builds a correct ssh invocation with the key loaded via ssh-add stdin (no file)', async () => {
    const { spawnFn, calls } = makeSpawn({ ssh: { exitCode: 0, stdout: 'hello', stderr: '' } });
    const result = await sshExec(reach, KEY, 'echo hello', {}, { spawnFn });

    expect(result).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });

    // ssh-add received the key on stdin — never a temp file.
    const add = calls.find((c) => c.command === 'ssh-add');
    expect(add?.args).toEqual(['-']);
    expect(add?.stdin).toContain('BEGIN OPENSSH PRIVATE KEY');

    // ssh ran with user@address, default port, accept-new host key.
    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.args).toContain('root@10.0.0.7');
    expect(ssh?.args).toContain('echo hello');
    expect(ssh?.args).toContain('-p');
    expect(ssh?.args[ssh.args.indexOf('-p') + 1]).toBe('22');
    expect(ssh?.args.join(' ')).toContain('StrictHostKeyChecking=accept-new');

    // The ephemeral agent is torn down.
    expect(calls.filter((c) => c.command === 'ssh-agent' && c.args[0] === '-k')).toHaveLength(1);
  });

  it('pipes opts.stdin to the remote command and overrides the port', async () => {
    const { spawnFn, calls } = makeSpawn();
    await sshExec(reach, KEY, 'cryptroot-unlock', { stdin: 'passphrase', port: 2222 }, { spawnFn });
    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.stdin).toBe('passphrase');
    expect(ssh?.args[ssh.args.indexOf('-p') + 1]).toBe('2222');
  });

  it('applies strict host-key mode when requested', async () => {
    const { spawnFn, calls } = makeSpawn();
    await sshExec(reach, KEY, 'true', { hostKeyMode: 'strict' }, { spawnFn });
    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.args.join(' ')).toContain('StrictHostKeyChecking=yes');
  });

  it('surfaces a non-zero exit code rather than throwing', async () => {
    const { spawnFn } = makeSpawn({ ssh: { exitCode: 7, stdout: '', stderr: 'boom' } });
    const result = await sshExec(reach, KEY, 'false', {}, { spawnFn });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('boom');
  });

  it('throws when reach has no address', async () => {
    const { spawnFn } = makeSpawn();
    await expect(
      sshExec({ ...reach, address: null }, KEY, 'true', {}, { spawnFn }),
    ).rejects.toThrow(/no SSH reach address/);
  });

  it('throws when ssh-add fails (bad key)', async () => {
    const { spawnFn } = makeSpawn({ 'ssh-add': { exitCode: 1, stdout: '', stderr: 'bad key' } });
    await expect(sshExec(reach, KEY, 'true', {}, { spawnFn })).rejects.toThrow(/ssh-add failed/);
  });
});

describe('sshPush', () => {
  it('ships local bytes via cat > path on stdin', async () => {
    const { spawnFn, calls } = makeSpawn();
    await sshPush(reach, KEY, 'binary-bytes', '/usr/local/bin/kici-agent', {}, { spawnFn });
    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.stdin).toBe('binary-bytes');
    expect(ssh?.args.join(' ')).toContain("cat > '/usr/local/bin/kici-agent'");
  });

  it('throws on a non-zero push exit', async () => {
    const { spawnFn } = makeSpawn({ ssh: { exitCode: 1, stdout: '', stderr: 'disk full' } });
    await expect(sshPush(reach, KEY, 'x', '/tmp/x', {}, { spawnFn })).rejects.toThrow(
      /sshPush.*exit 1/s,
    );
  });
});
