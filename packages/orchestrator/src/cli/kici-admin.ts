#!/usr/bin/env node
/**
 * kici-admin CLI binary.
 *
 * Manages secrets, tokens, key rotation, and audit logs
 * through the orchestrator's admin HTTP API.
 *
 * Global options:
 *   --url / -u    Orchestrator URL (env: KICI_ADMIN_URL, default: http://localhost:8080)
 *   --token / -t  Admin API token (env: KICI_ADMIN_TOKEN, required)
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { Command } from 'commander';
import { AdminApiClient } from './api-client.js';
import { registerSecretCommands } from './commands/secret.js';
import { registerRotateCommand } from './commands/rotate.js';
import { registerAuditCommands } from './commands/audit.js';
import { registerTokenCommands } from './commands/token.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerApiKeyCommands } from './commands/api-key.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDbCommands } from './commands/db.js';
import { registerSourceCommands } from './commands/source.js';
import { registerRemoteSourceCommands } from './commands/remote-source.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerRunsCommands } from './commands/runs.js';
import { registerEventLogCommands } from './commands/event-log.js';
import { registerAccessLogCommands } from './commands/access-log.js';
import { registerBackendCommands } from './commands/backend.js';
import { registerDiagnoseCommand } from './commands/diagnose.js';
import { registerDebugBundleCommand } from './commands/debug-bundle.js';
import { registerInspectBundleCommand } from './commands/inspect-bundle.js';
import { registerOrchestratorServiceCommands } from './commands/orchestrator-service/index.js';
import { registerAgentServiceCommands } from './commands/agent-service/index.js';
import { registerPeerCommands } from './commands/peer.js';
import { registerHostCommands } from './commands/host.js';
import { registerOrgSettingsCommands } from './commands/org-settings.js';
import { registerClusterNameCommands } from './commands/cluster-name.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerEnvironmentCommands } from './commands/environment.js';
import { registerVariableCommands } from './commands/variable.js';
import { registerQueueCommands } from './commands/queue.js';
import { registerExecutionCommands } from './commands/execution.js';
import { registerRegistrationCommands } from './commands/registration.js';
import { registerEventCommands } from './commands/event.js';
import { registerEventDlqCommands } from './commands/event-dlq.js';
import { registerColdStoreCommands } from './commands/cold-store.js';
import { registerFirecrackerCommands } from './commands/firecracker/index.js';
import { registerScalerCommands } from './commands/scaler.js';
import { registerJoinCommand } from './join.js';

/**
 * Build the kici-admin Commander program with every command group registered.
 * Exported so the surface registry can walk the real command tree without
 * parsing argv (no action runs during a tree walk, so `getClient` is
 * constructed but never invoked).
 */

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('kici-admin')
    .description('KiCI orchestrator admin CLI for managing config, secrets, and tokens')
    .version('0.0.1', '-V, --cli-version')
    .option(
      '-u, --url <url>',
      'Orchestrator URL',
      process.env.KICI_ADMIN_URL ?? 'http://localhost:8080',
    )
    .option('-t, --token <token>', 'Admin API token', process.env.KICI_ADMIN_TOKEN);

  /**
   * Create an AdminApiClient from global options.
   * Called lazily by each command to allow --help without requiring --token.
   */
  function getClient(): AdminApiClient {
    const opts = program.opts<{ url: string; token?: string }>();
    if (!opts.token) {
      console.error('Error: --token or KICI_ADMIN_TOKEN is required');
      process.exit(1);
    }
    return new AdminApiClient(opts.url, opts.token);
  }

  // Register all command groups
  registerSecretCommands(program, getClient);
  registerRotateCommand(program, getClient);
  registerAuditCommands(program, getClient);
  registerTokenCommands(program, getClient);
  registerAgentCommands(program, getClient);
  registerApiKeyCommands(program, getClient);
  registerConfigCommands(program, getClient);
  registerDbCommands(program, getClient);
  registerSourceCommands(program, getClient);
  registerRemoteSourceCommands(program);
  registerWorkflowCommands(program, getClient);
  registerRunsCommands(program, getClient);
  registerEventLogCommands(program, getClient);
  registerAccessLogCommands(program, getClient);
  registerBackendCommands(program, getClient);
  registerDiagnoseCommand(program, getClient);
  registerDebugBundleCommand(program, getClient);
  registerInspectBundleCommand(program);
  registerOrchestratorServiceCommands(program);
  // Firecracker host-networking ops (provision/verify/teardown bridges) run
  // locally on the orchestrator host — no admin HTTP client.
  registerFirecrackerCommands(program);
  // Scaler maintenance (reap-orphans) runs locally from config — no admin HTTP
  // client, no DB, no running orchestrator. Recovers a node wedged on ENOSPC.
  registerScalerCommands(program);
  // Agent service commands are added to the existing 'agent' command group
  // (registered above by registerAgentCommands), so this must come after it.
  registerAgentServiceCommands(program);
  // Peer commands use direct DB access (not AdminApiClient)
  registerPeerCommands(program, getClient);
  // Host roster commands use direct DB access (not AdminApiClient)
  registerHostCommands(program);
  registerOrgSettingsCommands(program, getClient);
  registerClusterNameCommands(program, getClient);
  // Maintenance commands extend `secret` and `source` namespaces with purge
  // verbs, so must run after registerSecretCommands / registerSourceCommands.
  registerMaintenanceCommands(program, getClient);
  // Environment CLI is a new top-level namespace (not an extension).
  registerEnvironmentCommands(program, getClient);
  // Variable CLI is a sibling namespace to `secret` — both write to the same
  // per-environment trust cone, gated by the dashboard-write policy.
  registerVariableCommands(program, getClient);
  // Queue + execution read verbs extend the namespaces created by
  // registerMaintenanceCommands (queue clear, execution purge-stale), so must
  // run after it.
  registerQueueCommands(program, getClient);
  registerExecutionCommands(program, getClient);
  // Registration CLI is a new top-level namespace (alongside the existing
  // `workflow list` — they cover different concerns).
  registerRegistrationCommands(program, getClient);
  // Event CLI is a new top-level namespace — `event emit` lands in kici_events
  // + pg_notify, mirroring the shared `emitKiciEventDirect` helper used by e2e.
  registerEventCommands(program, getClient);
  // `event-dlq` is the operator triage surface for at-least-once event delivery
  // — list / retry / discard events that exhausted their retry budget.
  registerEventDlqCommands(program, getClient);
  // Cold-store CLI stubs (standalone namespace; admin HTTP-backed).
  registerColdStoreCommands(program, getClient);
  // Join command does not use AdminApiClient (connects directly to Platform/peer)
  registerJoinCommand(program);

  return program;
}

/** Build the program and parse argv — the bin-shim entry point. */
export function runCli(argv: string[] = process.argv): void {
  buildProgram().parse(argv);
}

/**
 * Canonicalize a path through any symlinks, falling back to a plain `resolve`
 * when the target does not exist on disk. The entry-point guard compares the
 * invoked script path against this module's own path; both sides must be fully
 * canonicalized or a symlinked invocation path silently fails the match. The
 * canonical example is the light-package launcher running
 * `node /tmp/.../kici-admin.cjs` on macOS, where `/tmp` is a symlink to
 * `/private/tmp`: `process.argv[1]` keeps the `/tmp` form while the bundle's
 * `import.meta.url` resolves to the real `/private/tmp` path, so an
 * un-canonicalized comparison is always false and the CLI exits 0 without
 * running any command.
 */
export function canonicalize(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// Only parse argv when this module is the process entry point. The published
// bin shim imports `runCli` and calls it explicitly, so this guard fires only
// for a direct `node dist/cli.js` invocation; importing the module (e.g. the
// surface registry building the command tree) must NOT parse/exit.
if (canonicalize(process.argv[1] ?? '') === canonicalize(fileURLToPath(import.meta.url))) {
  runCli();
}
