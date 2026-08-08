/**
 * Orchestrator service command group registration.
 *
 * Registers `kici-admin orchestrator` with install, uninstall, start, stop,
 * restart, status, logs, upgrade, drain, and resume subcommands for managing the
 * orchestrator as a system service.
 *
 * The lifecycle verbs (install/start/stop/…) manage local services directly and
 * do NOT use AdminApiClient. The drain/resume verbs DO — they talk to the running
 * coordinator's admin HTTP API to quiesce it before an upgrade.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../../api-client.js';
import { registerOrchestratorInstall } from './install.js';
import { registerOrchestratorUninstall } from './uninstall.js';
import { registerOrchestratorStart } from './start.js';
import { registerOrchestratorStop } from './stop.js';
import { registerOrchestratorRestart } from './restart.js';
import { registerStatusCommand } from './status.js';
import { registerLogsCommand } from './logs.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerOrchestratorDrain } from './drain.js';

export function registerOrchestratorServiceCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
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
  registerOrchestratorDrain(orchestrator, getClient);
}
