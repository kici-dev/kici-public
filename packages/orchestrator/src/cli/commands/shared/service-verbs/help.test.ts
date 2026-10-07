/**
 * Pins the user-visible shape of the `kici-admin agent` and `kici-admin orchestrator`
 * service command groups: the order Commander lists their subcommands in, and the
 * full `--help` text of each lifecycle verb.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerAgentServiceCommands } from '../../agent-service/index.js';
import { registerOrchestratorServiceCommands } from '../../orchestrator-service/index.js';
import type { AdminApiClient } from '../../../api-client.js';

const VERBS = ['start', 'stop', 'restart', 'logs', 'uninstall'] as const;

function buildGroup(component: 'agent' | 'orchestrator'): Command {
  const program = new Command('kici-admin').configureHelp({ helpWidth: 100 });
  if (component === 'agent') {
    program.command('agent');
    registerAgentServiceCommands(program);
  } else {
    const noClient = (): AdminApiClient => {
      throw new Error('no client in a help test');
    };
    registerOrchestratorServiceCommands(program, noClient, () => null);
  }
  return program.commands.find((c) => c.name() === component)!;
}

describe('service command groups — help pin', () => {
  // fails-when: a refactor registers the lifecycle verbs in a different order,
  // which reorders the group's --help listing.
  it('lists the agent service verbs in the established order', () => {
    expect(buildGroup('agent').commands.map((c) => c.name())).toEqual([
      'install',
      'uninstall',
      'start',
      'stop',
      'restart',
      'status',
      'logs',
      'upgrade',
    ]);
  });

  it('lists the orchestrator service verbs in the established order', () => {
    expect(buildGroup('orchestrator').commands.map((c) => c.name())).toEqual([
      'install',
      'uninstall',
      'start',
      'stop',
      'restart',
      'status',
      'logs',
      'upgrade',
      'drain',
      'resume',
    ]);
  });

  // fails-when: a verb's description, an option flag, or an option's help text
  // changes for either component.
  describe.each(['agent', 'orchestrator'] as const)('%s', (component) => {
    it.each(VERBS)('%s --help is unchanged', (verb) => {
      const cmd = buildGroup(component).commands.find((c) => c.name() === verb)!;
      expect(cmd.helpInformation()).toMatchSnapshot();
    });
  });
});
