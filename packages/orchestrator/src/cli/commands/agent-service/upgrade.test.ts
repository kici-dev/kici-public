/**
 * Tests for the agent upgrade command's commander wiring.
 *
 * The upgrade body delegates to performVersionedUpgrade (covered separately
 * in shared/versioned-upgrade.test.ts). These tests verify the agent
 * subcommand registers the folder-anchored option set: --instance-dir is
 * present, --name has no default, and the action threads opts through to the
 * shared upgrade helper with component: 'agent'.
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

describe('agent upgrade — folder-anchored', () => {
  let program: Command;

  beforeEach(() => {
    mockPerformVersionedUpgrade.mockClear();
    program = new Command();
    program.name('agent');
    registerAgentUpgradeCommand(program);
  });

  it('refuses without --instance-dir/--name (delegates refusal to performVersionedUpgrade)', () => {
    // The `--name` option no longer has a default — commander parses without
    // injecting a value, leaving it undefined for the action callback.
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
    // No default --name in the parsed opts.
    expect((opts as { name?: string }).name).toBeUndefined();
  });
});
