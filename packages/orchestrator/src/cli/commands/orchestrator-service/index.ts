/**
 * Orchestrator service command group registration.
 *
 * Registers `kici-admin orchestrator` with install, uninstall, start, stop,
 * restart, status, logs, and upgrade subcommands for managing the orchestrator
 * as a system service.
 *
 * These commands manage local services directly and do NOT use AdminApiClient.
 */

import type { Command } from 'commander';
import { registerOrchestratorInstall } from './install.js';
import { registerOrchestratorUninstall } from './uninstall.js';
import { registerOrchestratorStart } from './start.js';
import { registerOrchestratorStop } from './stop.js';
import { registerOrchestratorRestart } from './restart.js';
import { registerStatusCommand } from './status.js';
import { registerLogsCommand } from './logs.js';
import { registerUpgradeCommand } from './upgrade.js';

export function registerOrchestratorServiceCommands(program: Command): void {
  const orchestrator = program
    .command('orchestrator')
    .description('Manage orchestrator service installation and lifecycle');

  registerOrchestratorInstall(orchestrator);
  registerOrchestratorUninstall(orchestrator);
  registerOrchestratorStart(orchestrator);
  registerOrchestratorStop(orchestrator);
  registerOrchestratorRestart(orchestrator);
  registerStatusCommand(orchestrator);
  registerLogsCommand(orchestrator);
  registerUpgradeCommand(orchestrator);
}
