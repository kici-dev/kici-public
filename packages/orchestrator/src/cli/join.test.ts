/**
 * `kici-admin join` writes one artifact: the env file
 * `orchestrator install --env-file` consumes.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const joinMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../cluster/join-client.js', () => ({
  DEFAULT_JOIN_ENV_FILE: './kici-orchestrator.env',
  JoinClient: class {
    join = joinMock;
  },
}));

import { registerJoinCommand } from './join.js';

const BASE_ARGS = ['join', '--token', 'kici_join_v1.a.b', '--peer', 'https://orch-1:8080'];

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerJoinCommand(program);
  return program;
}

async function runJoin(extraArgs: string[]) {
  const program = buildProgram();
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  try {
    await program.parseAsync([...BASE_ARGS, ...extraArgs], { from: 'user' });
    return {
      stdout: stdout.mock.calls.map((c) => c.join(' ')).join('\n'),
      stderr: stderr.mock.calls.map((c) => c.join(' ')).join('\n'),
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
}

describe('kici-admin join', () => {
  // fails-when: the option is registered again — the orchestrator boots from
  //   its environment, so a YAML artifact is a file nothing reads.
  it('refuses the removed --config option', async () => {
    await expect(
      buildProgram().parseAsync([...BASE_ARGS, '--config', './o.yaml'], { from: 'user' }),
    ).rejects.toThrow(/unknown option '--config'/);
    expect(joinMock).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: the default artifact still names the install command.
  it('prints the env-file next steps for the default path', async () => {
    const { stderr, stdout } = await runJoin([]);
    expect(stderr).toBe('');
    expect(stdout).toContain('cat ./kici-orchestrator.env');
    expect(stdout).toContain('install --env-file ./kici-orchestrator.env');
  });

  it('prints the env-file next steps for an explicit --env-file', async () => {
    const { stdout } = await runJoin(['--env-file', './o.env']);
    expect(stdout).toContain('cat ./o.env');
    expect(stdout).toContain('install --env-file ./o.env');
  });
});
