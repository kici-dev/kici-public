/**
 * Agent service command group registration.
 *
 * Adds install, uninstall, start, stop, restart, status, logs, and upgrade
 * subcommands to the existing `agent` command group for managing the agent
 * as a system service.
 *
 * These commands manage local services directly and do NOT use AdminApiClient.
 * They coexist with the existing agent token management commands (register, list, revoke).
 *
 * Must be called AFTER registerAgentCommands() so the `agent` command already exists.
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
