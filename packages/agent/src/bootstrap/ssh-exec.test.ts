import { describe, expect, it, vi } from 'vitest';
import {
  defaultSpawn,
  sshExec,
  sshPush,
  sshPushFile,
  type SpawnFn,
  type SshResult,
} from './ssh-exec.js';
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
  calls: Array<{ command: string; args: string[]; stdin?: string; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string; env: NodeJS.ProcessEnv }> =
    [];
  const ok: SshResult = { exitCode: 0, stdout: '', stderr: '' };
  const agentStart: SshResult = {
    exitCode: 0,
    stdout:
      'SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin, env: opts.env });
    // The agent start invocation is any ssh-agent call that is not the `-k`
    // teardown (start now carries `-a <sock> -s`, not just `-s`).
    if (command === 'ssh-agent' && args[0] !== '-k') return agentStart;
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

  it('binds the ephemeral agent to a KiCI-namespaced socket so leaked daemons are reapable', async () => {
    const { spawnFn, calls } = makeSpawn();
    await sshExec(reach, KEY, 'true', {}, { spawnFn });

    // ssh-agent is started with `-a <sock>` pointing at a kici-bootstrap-ssh-*
    // private dir — never the default /tmp/ssh-XXXX. kici-leak-sweep keys off
    // this prefix to reap orphans a SIGKILL left behind.
    const start = calls.find((c) => c.command === 'ssh-agent' && c.args[0] !== '-k');
    const bindIdx = start!.args.indexOf('-a');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    const sock = start!.args[bindIdx + 1];
    expect(sock).toMatch(/kici-bootstrap-ssh-[^/]+\/agent\.sock$/);

    // ssh runs against that same socket, not the value ssh-agent printed.
    const ssh = calls.find((c) => c.command === 'ssh');
    expect(ssh?.env.SSH_AUTH_SOCK).toBe(sock);
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

  it('clears an inherited SSH_AGENT_PID when the agent start output does not parse', async () => {
    // Simulate a login/parent ssh-agent already present in this process's env.
    const priorPid = process.env.SSH_AGENT_PID;
    process.env.SSH_AGENT_PID = '9999';
    try {
      // ssh-agent start stdout that parseAgentPid cannot extract a PID from
      // (no `SSH_AGENT_PID=<n>;` token) — the fallback branch.
      const { spawnFn, calls } = makeSpawn();
      const unparsable: SshResult = {
        exitCode: 0,
        stdout: 'SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\n',
        stderr: '',
      };
      // Override the ssh-agent START result (any ssh-agent call that is not -k).
      const wrapped: SpawnFn = async (command, args, opts) => {
        if (command === 'ssh-agent' && args[0] !== '-k') {
          // still record the call via the underlying spawnFn's recorder
          return spawnFn(command, args, { ...opts, env: opts.env }).then(() => unparsable);
        }
        return spawnFn(command, args, opts);
      };

      await sshExec(reach, KEY, 'true', {}, { spawnFn: wrapped });

      // The parent PID must NOT reach the key-load, the body ssh call, or teardown.
      const add = calls.find((c) => c.command === 'ssh-add');
      const ssh = calls.find((c) => c.command === 'ssh');
      const kill = calls.find((c) => c.command === 'ssh-agent' && c.args[0] === '-k');
      expect(add?.env.SSH_AGENT_PID).toBeUndefined();
      expect(ssh?.env.SSH_AGENT_PID).toBeUndefined();
      expect(kill?.env.SSH_AGENT_PID).toBeUndefined();
      // Structural invariant: the key is absent, not merely set to the string.
      expect(add && 'SSH_AGENT_PID' in add.env).toBe(false);
      expect(kill && 'SSH_AGENT_PID' in kill.env).toBe(false);
      // The socket is still our ephemeral one (unchanged behavior).
      expect(kill?.env.SSH_AUTH_SOCK).toMatch(/kici-bootstrap-ssh-[^/]+\/agent\.sock$/);
    } finally {
      if (priorPid === undefined) delete process.env.SSH_AGENT_PID;
      else process.env.SSH_AGENT_PID = priorPid;
    }
  });

  it('carries the ephemeral agent PID (not any inherited one) when start output parses', async () => {
    const priorPid = process.env.SSH_AGENT_PID;
    process.env.SSH_AGENT_PID = '9999';
    try {
      // makeSpawn's default agentStart stdout carries SSH_AGENT_PID=4242.
      const { spawnFn, calls } = makeSpawn();
      await sshExec(reach, KEY, 'true', {}, { spawnFn });
      const kill = calls.find((c) => c.command === 'ssh-agent' && c.args[0] === '-k');
      expect(kill?.env.SSH_AGENT_PID).toBe('4242');
      expect(kill?.env.SSH_AGENT_PID).not.toBe('9999');
    } finally {
      if (priorPid === undefined) delete process.env.SSH_AGENT_PID;
      else process.env.SSH_AGENT_PID = priorPid;
    }
  });
});

describe('defaultSpawn', () => {
  it('resolves with the exit code when the child drops its stdin read end (EPIPE), without crashing', async () => {
    // A child that exits immediately without reading stdin closes its read end
    // while a large write is still pending, so child.stdin emits EPIPE. Without
    // an 'error' handler on the stdin stream this becomes an uncaught exception
    // that would crash the agent process; with the handler the promise still
    // resolves via the process 'close' event carrying the real exit code.
    //
    // The payload must exceed the kernel pipe buffer (64 KiB on Linux) so the
    // write cannot fully buffer before the reader exits — that is what
    // guarantees the pending write hits EPIPE rather than silently succeeding.
    const bigStdin = 'x'.repeat(1024 * 1024); // 1 MiB
    const result = await defaultSpawn('sh', ['-c', 'exit 42'], {
      env: process.env,
      stdin: bigStdin,
    });
    expect(result.exitCode).toBe(42);
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

describe('sshPushFile (binary-safe scp)', () => {
  it('streams a local file over scp -P with the key from the ephemeral agent', async () => {
    const { spawnFn, calls } = makeSpawn();
    await sshPushFile(reach, KEY, '/tmp/payload.tar.gz', '/tmp/p.tgz', {}, { spawnFn });

    // A binary payload MUST NOT take the string `cat >` path — no ssh call at all.
    expect(calls.some((c) => c.command === 'ssh')).toBe(false);

    const scp = calls.find((c) => c.command === 'scp');
    expect(scp).toBeDefined();
    expect(scp?.args).toContain('-P');
    expect(scp?.args).toContain('22');
    expect(scp?.args).toContain('/tmp/payload.tar.gz');
    expect(scp?.args).toContain('root@10.0.0.7:/tmp/p.tgz');
    // The key rides the ephemeral agent (SSH_AUTH_SOCK), never a temp key file.
    expect(scp?.args.join(' ')).not.toContain('-i');
    expect(scp?.env.SSH_AUTH_SOCK).toBeDefined();
    expect(calls.some((c) => c.command === 'ssh-add')).toBe(true);
  });

  it('throws on a non-zero scp exit', async () => {
    const { spawnFn } = makeSpawn({ scp: { exitCode: 1, stdout: '', stderr: 'no space' } });
    await expect(
      sshPushFile(reach, KEY, '/tmp/p.tar.gz', '/tmp/p.tgz', {}, { spawnFn }),
    ).rejects.toThrow(/sshPushFile.*exit 1/s);
  });
});
