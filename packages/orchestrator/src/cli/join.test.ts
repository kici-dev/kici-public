/**
 * `kici-admin join` reports the deprecated artifact whenever it writes one.
 *
 * `--config` writes the local YAML the orchestrator never reads. It does that
 * whether or not `--env-file` is also given, so the notice is keyed on the
 * flag that produces the file, not on the flag combination.
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

async function runJoin(extraArgs: string[]) {
  const program = new Command();
  program.exitOverride();
  registerJoinCommand(program);

  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  try {
    await program.parseAsync(
      ['join', '--token', 'kici_join_v1.a.b', '--peer', 'https://orch-1:8080', ...extraArgs],
      { from: 'user' },
    );
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
  // fails-when: the notice is gated on `--config && !--env-file`. Passing both
  //   then writes ./o.yaml — carrying the cluster's secrets encryption key —
  //   with nothing said about it.
  it('reports the deprecation when --config is paired with --env-file', async () => {
    const { stderr } = await runJoin(['--config', './o.yaml', '--env-file', './o.env']);
    expect(stderr).toContain('--config is deprecated');
    expect(stderr).toContain('./o.yaml');
  });

  it('reports it for --config on its own', async () => {
    const { stderr, stdout } = await runJoin(['--config', './o.yaml']);
    expect(stderr).toContain('--config is deprecated');
    expect(stdout).toContain('cat ./o.yaml');
  });

  // breaks-if-wrong: a join that writes no YAML must stay quiet, or the notice
  //   is noise on the path we want operators to take. The env-file next steps
  //   still print, so the branch is reached rather than skipped.
  it('says nothing when no YAML is written', async () => {
    const { stderr, stdout } = await runJoin([]);
    expect(stderr).toBe('');
    expect(stdout).toContain('install --env-file ./kici-orchestrator.env');
  });

  // With both flags the env-file next steps are the ones printed, since that
  // is the artifact the install consumes.
  it('prints the env-file next steps when both flags are given', async () => {
    const { stdout } = await runJoin(['--config', './o.yaml', '--env-file', './o.env']);
    expect(stdout).toContain('install --env-file ./o.env');
    expect(stdout).not.toContain('cat ./o.yaml');
  });
});
