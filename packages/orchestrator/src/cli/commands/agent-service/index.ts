/**
 * Adds install, uninstall, start, stop, restart, status, logs and upgrade
 * to the `agent` group beside its token commands (register, list,
 * revoke). They manage local services directly and do NOT use AdminApiClient.
 * Must run AFTER registerAgentCommands(), which creates the group.
 */

import type { Command } from 'commander';
import { registerAgentInstall } from './install.js';
import { registerAgentStatusCommand } from './status.js';
import { registerAgentUpgradeCommand } from './upgrade.js';
import { registerServiceLifecycleVerbs, registerServiceLogsVerb } from '../shared/service-verbs.js';

export function registerAgentServiceCommands(program: Command): void {
  const agent = program.commands.find((cmd) => cmd.name() === 'agent');
  if (!agent) {
    throw new Error(
      'agent command group not found. registerAgentServiceCommands must be called after registerAgentCommands.',
    );
  }

  registerAgentInstall(agent);
  registerServiceLifecycleVerbs(agent, 'agent');
  registerAgentStatusCommand(agent);
  registerServiceLogsVerb(agent, 'agent');
  registerAgentUpgradeCommand(agent);
}
