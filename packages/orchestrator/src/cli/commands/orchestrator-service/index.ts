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
import { registerStatusCommand } from './status.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerOrchestratorDrain } from './drain.js';
import { registerServiceLifecycleVerbs, registerServiceLogsVerb } from '../shared/service-verbs.js';

export function registerOrchestratorServiceCommands(
  program: Command,
  getClient: () => AdminApiClient,
  /**
   * Non-exiting client factory for the upgrade command. Its drain and
   * schema-guard steps improve on a path that previously did neither, so an
   * install with no admin credentials must still be able to upgrade — and
   * `getClient` exits the process rather than throwing, which a caller cannot
   * catch.
   */
  tryGetClient: () => AdminApiClient | null,
): void {
  const orchestrator = program
    .command('orchestrator')
    .description('Manage orchestrator service installation and lifecycle');

  registerOrchestratorInstall(orchestrator);
  registerServiceLifecycleVerbs(orchestrator, 'orchestrator');
  registerStatusCommand(orchestrator);
  registerServiceLogsVerb(orchestrator, 'orchestrator');
  registerUpgradeCommand(orchestrator, tryGetClient);
  registerOrchestratorDrain(orchestrator, getClient);
}
