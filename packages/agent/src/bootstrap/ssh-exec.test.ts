import { describe, expect, it, vi } from 'vitest';
import {
  defaultSpawn,
  isPreSessionFailure,
  SSH_SESSION_ATTEMPTS,
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
    // Any ssh-agent call but the `-k` teardown is the start (`-a <sock> -s`).
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

    // Never the default /tmp/ssh-XXXX: a host cleanup job keys off the
    // kici-bootstrap-ssh-* prefix to reap orphans a SIGKILL left behind.
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
    // An inherited login/parent ssh-agent.
    const priorPid = process.env.SSH_AGENT_PID;
    process.env.SSH_AGENT_PID = '9999';
    try {
      // No `SSH_AGENT_PID=<n>;` token: parseAgentPid's fallback branch.
      const { spawnFn, calls } = makeSpawn();
      const unparsable: SshResult = {
        exitCode: 0,
        stdout: 'SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\n',
        stderr: '',
      };
      // Override the start result, still recording the call.
      const wrapped: SpawnFn = async (command, args, opts) => {
        if (command === 'ssh-agent' && args[0] !== '-k') {
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
      // The socket is still the ephemeral one.
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
    // A child exiting without reading stdin makes the pending write EPIPE.
    // Without a stdin 'error' handler that is an uncaught exception crashing
    // the agent; with it the promise resolves on 'close' with the real exit
    // code. The payload exceeds the kernel pipe buffer (64 KiB on Linux) so
    // the write cannot fully buffer and must hit EPIPE.
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

describe('pre-session connection retry', () => {
  const BANNER_TIMEOUT: SshResult = {
    exitCode: 255,
    stdout: '',
    stderr:
      'Connection timed out during banner exchange\r\nConnection to 10.0.0.7 port 22 timed out\r\n',
  };
  const ok: SshResult = { exitCode: 0, stdout: 'done', stderr: '' };

  /** A spawn whose `command` calls answer `results` in order, then succeed. */
  function sequence(command: 'ssh' | 'scp', results: SshResult[]) {
    const { spawnFn: base, calls } = makeSpawn();
    const queue = [...results];
    const spawnFn: SpawnFn = async (cmd, args, opts) => {
      if (cmd !== command) return base(cmd, args, opts);
      await base(cmd, args, opts);
      return queue.shift() ?? ok;
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const attempts = () => calls.filter((c) => c.command === command).length;
    return { deps: { spawnFn, sleep }, attempts, sleeps };
  }

  it('classifies only an exit-255 failure before the session as pre-session', () => {
    expect(isPreSessionFailure(BANNER_TIMEOUT)).toBe(true);
    expect(
      isPreSessionFailure({
        exitCode: 255,
        stdout: '',
        stderr: 'ssh: connect to host 10.0.0.7 port 22: Connection timed out\r\n',
      }),
    ).toBe(true);
    expect(
      isPreSessionFailure({
        exitCode: 255,
        stdout: '',
        stderr: 'kex_exchange_identification: read: Connection reset by peer\r\n',
      }),
    ).toBe(true);
    // A remote command that itself exited 255 carries none of ssh's messages.
    expect(isPreSessionFailure({ exitCode: 255, stdout: '', stderr: 'boom' })).toBe(false);
    // The same text on another exit code is a remote command's output.
    expect(isPreSessionFailure({ ...BANNER_TIMEOUT, exitCode: 1 })).toBe(false);
    // An established session that drops (a pre-boot unlock rebooting the box) is not retried.
    expect(
      isPreSessionFailure({
        exitCode: 255,
        stdout: '',
        stderr: 'Connection to 10.0.0.7 closed by remote host.\r\n',
      }),
    ).toBe(false);
    expect(
      isPreSessionFailure({ exitCode: 255, stdout: '', stderr: 'Permission denied (publickey).' }),
    ).toBe(false);
  });

  // fails-when: a banner-exchange timeout is returned as-is — the bring-up then fails on one
  // slow connection, as fresh-box-bringup-arm did against a loaded Raspberry Pi.
  it('sshPush retries a banner-exchange timeout and succeeds', async () => {
    const { deps, attempts, sleeps } = sequence('ssh', [BANNER_TIMEOUT]);
    await sshPush(reach, KEY, 'launcher', '/tmp/kici-init-runner.sh', {}, deps);
    expect(attempts()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('sshExec returns the command result after a pre-session retry', async () => {
    const { deps, attempts } = sequence('ssh', [BANNER_TIMEOUT, BANNER_TIMEOUT]);
    const result = await sshExec(reach, KEY, 'true', {}, deps);
    expect(result).toEqual(ok);
    expect(attempts()).toBe(3);
  });

  it('sshPushFile retries scp the same way', async () => {
    const { deps, attempts } = sequence('scp', [BANNER_TIMEOUT]);
    await sshPushFile(reach, KEY, '/tmp/p.tar.gz', '/tmp/p.tgz', {}, deps);
    expect(attempts()).toBe(2);
  });

  it(`gives up after ${SSH_SESSION_ATTEMPTS} attempts and reports the last failure`, async () => {
    const { deps, attempts } = sequence(
      'ssh',
      Array.from({ length: SSH_SESSION_ATTEMPTS + 1 }, () => BANNER_TIMEOUT),
    );
    await expect(sshPush(reach, KEY, 'x', '/tmp/x', {}, deps)).rejects.toThrow(
      /exit 255.*banner exchange/s,
    );
    expect(attempts()).toBe(SSH_SESSION_ATTEMPTS);
  });

  // breaks-if-wrong: a remote command that ran and failed must never run a second time.
  it('never re-runs a command that ran and failed', async () => {
    const { deps, attempts, sleeps } = sequence('ssh', [
      { exitCode: 255, stdout: '', stderr: 'remote script exited 255' },
    ]);
    const result = await sshExec(reach, KEY, 'exit 255', {}, deps);
    expect(result.exitCode).toBe(255);
    expect(attempts()).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});
