/**
 * `kici-admin orchestrator`: manages the orchestrator as a system service. The
 * lifecycle verbs act on local services and do NOT use AdminApiClient; drain
 * and resume DO, quiescing the running coordinator before an upgrade.
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
   * Non-exiting client factory for upgrade: its drain and schema-guard steps
   * are optional, so an install with no admin credentials still upgrades, and
   * `getClient` exits the process, which a caller cannot catch.
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
