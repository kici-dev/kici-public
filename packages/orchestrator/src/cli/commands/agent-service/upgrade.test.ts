/**
 * Commander wiring of `agent upgrade` only; the body is performVersionedUpgrade,
 * covered in shared/versioned-upgrade.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockPerformVersionedUpgrade = vi.fn().mockResolvedValue(undefined);

vi.mock('../shared/versioned-upgrade.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/versioned-upgrade.js')>(
    '../shared/versioned-upgrade.js',
  );
  return {
    ...actual,
    performVersionedUpgrade: (...args: unknown[]) => mockPerformVersionedUpgrade(...args),
  };
});

import { registerAgentUpgradeCommand } from './upgrade.js';
import { NODE_OPTION_DESCRIPTION } from '../shared/node-runtime.js';

describe('agent upgrade — folder-anchored', () => {
  let program: Command;

  beforeEach(() => {
    mockPerformVersionedUpgrade.mockClear();
    program = new Command();
    program.name('agent');
    registerAgentUpgradeCommand(program);
  });

  it('refuses without --instance-dir/--name (delegates refusal to performVersionedUpgrade)', () => {
    const cmd = program.commands.find((c) => c.name() === 'upgrade')!;
    const nameOption = cmd.options.find((o) => o.long === '--name');
    expect(nameOption).toBeDefined();
    expect(nameOption!.defaultValue).toBeUndefined();

    const instanceDirOption = cmd.options.find((o) => o.long === '--instance-dir');
    expect(instanceDirOption).toBeDefined();
  });

  it('calls performVersionedUpgrade with component: agent and the parsed opts', async () => {
    await program.parseAsync([
      'node',
      'agent',
      'upgrade',
      '--instance-dir',
      '/tmp/some-dir',
      '--version',
      '0.3.0',
    ]);

    expect(mockPerformVersionedUpgrade).toHaveBeenCalledTimes(1);
    const [component, opts] = mockPerformVersionedUpgrade.mock.calls[0]!;
    expect(component).toBe('agent');
    expect(opts).toMatchObject({
      instanceDir: '/tmp/some-dir',
      version: '0.3.0',
    });
    expect((opts as { name?: string }).name).toBeUndefined();
  });
});

describe('agent upgrade --node', () => {
  it('passes --node to performVersionedUpgrade and describes it in --help', async () => {
    mockPerformVersionedUpgrade.mockClear();
    const program = new Command();
    program.name('agent');
    registerAgentUpgradeCommand(program);
    await program.parseAsync([
      'node',
      'agent',
      'upgrade',
      '--version',
      '0.27.0',
      '--node',
      'C:\\n\\node.exe',
    ]);
    expect(mockPerformVersionedUpgrade.mock.calls[0]![1]).toMatchObject({
      node: 'C:\\n\\node.exe',
    });
    const option = program.commands[0]!.options.find((o) => o.long === '--node');
    expect(option?.flags).toBe('--node <path>');
    expect(option?.description).toBe(NODE_OPTION_DESCRIPTION);
  });
});
