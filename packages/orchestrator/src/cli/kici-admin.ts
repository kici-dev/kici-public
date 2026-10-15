#!/usr/bin/env node
/**
 * kici-admin CLI binary. Global options: `--url`/`-u` (env KICI_ADMIN_URL,
 * default http://localhost:4000), `--token`/`-t` (env KICI_ADMIN_TOKEN), and
 * `-V`/`--cli-version`/`--version` (`--version` only before a command).
 *
 * A command that declares its own option under one of these flags (for
 * example `orchestrator upgrade --url`) owns that flag after its name; see
 * `root-option-routing.ts`.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { Command, type ParseOptionsResult } from 'commander';
import { AdminApiClient, DEFAULT_ADMIN_URL } from './api-client.js';
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
import { registerAttestationsCommands } from './commands/attestations.js';
import { registerSigningKeyCommands } from './commands/signing-key.js';
import { registerDashboardEncryptionKeyCommands } from './commands/dashboard-encryption-key.js';
import { registerEventLogCommands } from './commands/event-log.js';
import { registerAccessLogCommands } from './commands/access-log.js';
import { registerBackendCommands } from './commands/backend.js';
import { registerDiagnoseCommand } from './commands/diagnose.js';
import { registerDebugBundleCommand } from './commands/debug-bundle.js';
import { registerInspectBundleCommand } from './commands/inspect-bundle.js';
import { registerOrchestratorServiceCommands } from './commands/orchestrator-service/index.js';
import { registerAgentServiceCommands } from './commands/agent-service/index.js';
import { registerAgentPackage } from './commands/agent-package.js';
import { registerPeerCommands } from './commands/peer.js';
import { registerHostCommands } from './commands/host.js';
import { registerOrgCommands } from './commands/org.js';
import { registerOrgSettingsCommands } from './commands/org-settings.js';
import { registerClusterSettingsCommands } from './commands/cluster-settings.js';
import { registerTrustPolicyCommands } from './commands/trust-policy.js';
import { registerHeldRunCommands } from './commands/held-run.js';
import { registerClusterNameCommands } from './commands/cluster-name.js';
import { registerClusterCommands } from './commands/cluster.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerContextCommands } from './commands/context.js';
import { registerVariableCommands } from './commands/variable.js';
import { registerQueueCommands } from './commands/queue.js';
import { registerExecutionCommands } from './commands/execution.js';
import { registerCheckRunCommands } from './commands/check-run.js';
import { registerRegistrationCommands } from './commands/registration.js';
import { registerEventCommands } from './commands/event.js';
import { registerEventDlqCommands } from './commands/event-dlq.js';
import { registerColdStoreCommands } from './commands/cold-store.js';
import { registerFirecrackerCommands } from './commands/firecracker/index.js';
import { registerScalerCommands } from './commands/scaler.js';
import { registerJoinCommand } from './join.js';
import { ROOT_VERSION_FLAG, routeRootArgs } from './root-option-routing.js';

declare const KICI_PKG_VERSION: string;

/**
 * `scripts/build-service.mjs` defines `KICI_PKG_VERSION` for every orchestrator
 * build entry; the fallback covers a source run (tests, `tsx`), the same shape
 * `server.ts` and `standalone.ts` use for `ORCHESTRATOR_VERSION`.
 */
export const CLI_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.1';

/**
 * Root command whose option parsing first routes argv through
 * {@link routeRootArgs}: a leading `--version` prints the CLI version, and an
 * option a command declares under a root option's flag reaches that command.
 * Subcommands are plain `Command`s.
 */
class KiciAdminProgram extends Command {
  override parseOptions(args: string[]): ParseOptionsResult {
    const routed = routeRootArgs(this, args);
    const parsed = super.parseOptions(routed.args);
    return {
      operands: parsed.operands.map(routed.restore),
      unknown: parsed.unknown.map(routed.restore),
    };
  }
}

/**
 * Exported so the surface registry can walk the real command tree without
 * parsing argv; no action runs, so `getClient` is never invoked.
 */

export function buildProgram(): Command {
  const program = new KiciAdminProgram();

  program
    .name('kici-admin')
    .description('KiCI orchestrator admin CLI for managing config, secrets, and tokens')
    .version(
      CLI_VERSION,
      `-V, ${ROOT_VERSION_FLAG}`,
      'output the version number (--version also works before a command)',
    )
    .option('-u, --url <url>', 'Orchestrator URL', process.env.KICI_ADMIN_URL ?? DEFAULT_ADMIN_URL)
    .option('-t, --token <token>', 'Admin API token', process.env.KICI_ADMIN_TOKEN);

  /** Lazy, so --help works without --token. */
  function getClient(): AdminApiClient {
    const opts = program.opts<{ url: string; token?: string }>();
    if (!opts.token) {
      console.error('Error: --token or KICI_ADMIN_TOKEN is required');
      process.exit(1);
    }
    return new AdminApiClient(opts.url, opts.token);
  }

  /**
   * Like {@link getClient}, but null instead of exiting without a token. Upgrade's
   * drain and schema-guard steps are best-effort, so an install with no admin
   * credentials must still upgrade, and `getClient`'s exit cannot be caught.
   */
  function tryGetClient(): AdminApiClient | null {
    const opts = program.opts<{ url: string; token?: string }>();
    return opts.token ? new AdminApiClient(opts.url, opts.token) : null;
  }

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
  registerAttestationsCommands(program, getClient);
  registerSigningKeyCommands(program, tryGetClient);
  registerDashboardEncryptionKeyCommands(program);
  registerEventLogCommands(program, getClient);
  registerAccessLogCommands(program, getClient);
  registerBackendCommands(program, getClient);
  registerDiagnoseCommand(program, getClient);
  registerDebugBundleCommand(program, getClient);
  registerInspectBundleCommand(program);
  registerOrchestratorServiceCommands(program, getClient, tryGetClient);
  // Runs locally on the orchestrator host; no admin HTTP client.
  registerFirecrackerCommands(program);
  // `reap-orphans` runs locally from config (no HTTP, DB or running orchestrator)
  // to recover a node wedged on ENOSPC.
  registerScalerCommands(program, getClient);
  // Extends the 'agent' group, so it must come after registerAgentCommands.
  registerAgentServiceCommands(program);
  // Also extends the 'agent' group.
  registerAgentPackage(program);
  // Direct DB, except `peer forget`, which uses the admin HTTP API.
  registerPeerCommands(program, getClient);
  // Direct DB access.
  registerHostCommands(program);
  registerOrgCommands(program, getClient);
  registerOrgSettingsCommands(program, getClient);
  registerClusterSettingsCommands(program, getClient);
  registerTrustPolicyCommands(program, getClient);
  registerHeldRunCommands(program, getClient);
  registerClusterNameCommands(program, getClient);
  // DB + S3 direct, so it works while the orchestrator crash-loops on an identity mismatch.
  registerClusterCommands(program);
  // Extends `secret` and `source`, so it must run after their registration.
  registerMaintenanceCommands(program, getClient);
  registerContextCommands(program, getClient);
  // Shares `secret`'s per-environment trust cone and dashboard-write policy.
  registerVariableCommands(program, getClient);
  // Extend namespaces registerMaintenanceCommands creates, so they must run after it.
  registerQueueCommands(program, getClient);
  registerExecutionCommands(program, getClient);
  // Direct-DB only: no admin HTTP route.
  registerCheckRunCommands(program);
  registerRegistrationCommands(program, getClient);
  // `event emit` writes kici_events + pg_notify, mirroring `emitKiciEventDirect`.
  registerEventCommands(program, getClient);
  registerEventDlqCommands(program, getClient);
  registerColdStoreCommands(program, getClient);
  // Connects directly to the Platform or a peer; no AdminApiClient.
  registerJoinCommand(program);

  return program;
}

/** The bin-shim entry point. */
export function runCli(argv: string[] = process.argv): void {
  buildProgram().parse(argv);
}

/**
 * Resolve symlinks, falling back to `resolve` for a missing path. The
 * entry-point guard needs both sides canonical: on macOS `/tmp` links to
 * `/private/tmp`, so `process.argv[1]` and `import.meta.url` differ and the CLI
 * would exit 0 without running any command.
 */
export function canonicalize(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// Fires only for a direct `node dist/cli.js` run (the bin shim calls `runCli`);
// importing the module must never parse argv or exit.
if (canonicalize(process.argv[1] ?? '') === canonicalize(fileURLToPath(import.meta.url))) {
  runCli();
}
