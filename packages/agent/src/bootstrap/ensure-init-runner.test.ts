import { describe, it, expect, vi } from 'vitest';
import { ensureInitRunner } from './ensure-init-runner.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const MATERIAL = {
  broughtUp: true,
  reach: { agentId: 'box-00007', address: '10.0.0.7', sshUser: 'root', sshPort: 22 },
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----',
  bootstrapToken: 'kat_boottoken',
  targetAgentId: 'box-00007',
  orchestratorUrl: 'ws://10.0.0.1:4000/ws',
  labels: ['kici:init', 'kici:privileged:root', 'kici:host:box-00007'],
};

function makeSpawn(): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\nSSH_AGENT_PID=1;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin });
    if (command === 'ssh-agent' && args[0] === '-s') return agentStart;
    return { exitCode: 0, stdout: 'init-runner started pid=42', stderr: '' };
  });
  return { spawnFn, calls };
}

describe('ensureInitRunner (agent-side)', () => {
  it('returns broughtUp:false when the orchestrator no-ops', async () => {
    const transport = vi.fn(async () => ({ broughtUp: false }));
    const { spawnFn, calls } = makeSpawn();
    const result = await ensureInitRunner(transport, 'box-00007', { spawnFn });
    expect(result).toEqual({ broughtUp: false });
    // No SSH at all on a no-op.
    expect(calls).toHaveLength(0);
  });

  it('pushes a launcher and starts the init-runner with the bootstrap env', async () => {
    const transport = vi.fn(async () => MATERIAL);
    const { spawnFn, calls } = makeSpawn();
    const result = await ensureInitRunner(transport, 'box-00007', { spawnFn });

    expect(result).toEqual({ broughtUp: true });
    expect(transport).toHaveBeenCalledWith('kici.ensureInitRunner', { targetAgentId: 'box-00007' });

    // The launcher was pushed via cat > path (stdin carries the script, which
    // embeds the bootstrap token + agent id + orchestrator URL + labels).
    const push = calls.find((c) => c.command === 'ssh' && c.stdin?.includes('KICI_AGENT_TOKEN'));
    expect(push?.stdin).toContain('kat_boottoken');
    expect(push?.stdin).toContain('KICI_AGENT_ID=');
    expect(push?.stdin).toContain('box-00007');
    expect(push?.stdin).toContain('ws://10.0.0.1:4000/ws');
    expect(push?.stdin).toContain('kici:init');

    // A run invocation chmod's + executes the launcher.
    const run = calls.find((c) => c.command === 'ssh' && c.args.some((a) => a.includes('chmod')));
    expect(run).toBeDefined();
  });

  it('throws when the orchestrator returns incomplete material', async () => {
    const transport = vi.fn(async () => ({ broughtUp: true })); // missing key/token/etc
    const { spawnFn } = makeSpawn();
    await expect(ensureInitRunner(transport, 'box-00007', { spawnFn })).rejects.toThrow(
      /incomplete bring-up material/,
    );
  });

  it('throws when the launch fails', async () => {
    const transport = vi.fn(async () => MATERIAL);
    const calls: Array<string> = [];
    const spawnFn: SpawnFn = vi.fn(async (command, args) => {
      calls.push(command);
      if (command === 'ssh-agent' && args[0] === '-s') {
        return { exitCode: 0, stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\n', stderr: '' };
      }
      // push succeeds, run fails.
      if (command === 'ssh' && args.some((a) => a.includes('chmod'))) {
        return { exitCode: 1, stdout: '', stderr: 'no such binary' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(ensureInitRunner(transport, 'box-00007', { spawnFn })).rejects.toThrow(
      /init-runner launch.*failed/s,
    );
  });
});
