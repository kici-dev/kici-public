/**
 * kici orchestrators commands
 *
 * Inspect the org's connected orchestrator clusters and pick a per-org default
 * for `kici run remote`. `list` reads the Platform orchestrators index;
 * `use <name>` records `config.defaultClusters[orgId]` so a developer with a
 * preferred cluster types no `--orchestrator` flag.
 */

import pc from 'picocolors';
import { loadGlobalConfig, mergeGlobalConfig, type GlobalConfig } from '../remote/config.js';

/** Options shared by the orchestrators subcommands. */
export interface OrchestratorsOptions {
  /** Target organization id (overrides config.activeOrgId). */
  org?: string;
}

/** One connected orchestrator cluster, as returned by the Platform index. */
interface OrchestratorEntry {
  clusterName: string | null;
  routingKeys: string[];
  orchVersion: string | null;
}

/**
 * Resolve the authenticated config + the target org id, printing an actionable
 * error and returning null when either is missing.
 */
async function resolveOrgContext(
  options: OrchestratorsOptions,
): Promise<{ config: GlobalConfig; orgId: string } | null> {
  const config = await loadGlobalConfig();
  if (!config.pat) {
    console.error(pc.red('Not logged in. Run `kici login` first.'));
    return null;
  }
  if (!config.platformEndpoint) {
    console.error(
      pc.red('No Platform endpoint configured. Run `kici login` to set up your Platform.'),
    );
    return null;
  }
  const orgId = options.org ?? config.activeOrgId;
  if (!orgId) {
    console.error(
      pc.red('No target organization. Select one with `kici org use <org>` or pass `--org <id>`.'),
    );
    return null;
  }
  return { config, orgId };
}

/**
 * Fetch the org's connected orchestrator clusters from the Platform index.
 * Returns null on an auth/HTTP failure (after printing an error).
 */
async function fetchOrchestrators(
  config: GlobalConfig,
  orgId: string,
): Promise<OrchestratorEntry[] | null> {
  const url = `${config.platformEndpoint}/api/v1/orgs/${orgId}/orchestrators`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.pat}`, 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 401) {
      console.error(
        pc.red(
          'Authentication failed. Your token may be expired. Run `kici login` to re-authenticate.',
        ),
      );
      return null;
    }
    console.error(pc.red(`Failed to list orchestrators: HTTP ${response.status}`));
    return null;
  }

  const body = (await response.json()) as { orchestrators?: OrchestratorEntry[] };
  return body.orchestrators ?? [];
}

/**
 * List the org's connected orchestrator clusters, marking the per-org default.
 */
export async function orchestratorsListCommand(options: OrchestratorsOptions): Promise<boolean> {
  const ctx = await resolveOrgContext(options);
  if (!ctx) return false;

  const orchestrators = await fetchOrchestrators(ctx.config, ctx.orgId);
  if (orchestrators === null) return false;

  if (orchestrators.length === 0) {
    console.log(pc.gray('No orchestrators are connected for this organization.'));
    return true;
  }

  const defaultCluster = ctx.config.defaultClusters?.[ctx.orgId];

  console.log(pc.bold('\nOrchestrators:\n'));
  const names = orchestrators.map((o) => o.clusterName ?? '(unnamed)');
  const nameWidth = Math.max(12, ...names.map((n) => n.length)) + 2;

  for (const orch of orchestrators) {
    const name = orch.clusterName ?? '(unnamed)';
    const isDefault = orch.clusterName !== null && orch.clusterName === defaultCluster;
    const marker = isDefault ? pc.green('* ') : '  ';
    const display = isDefault ? pc.bold(name) : name;
    const version = orch.orchVersion ? pc.gray(`v${orch.orchVersion}`) : pc.gray('(unknown)');
    console.log(`  ${marker}${display.padEnd(nameWidth)} ${version}`);
  }

  console.log('');
  console.log(pc.gray('Set a default with `kici orchestrators use <name>`.'));
  return true;
}

/**
 * Set the per-org default orchestrator cluster.
 *
 * Validates the cluster name against the org's connected clusters before
 * writing it to `config.defaultClusters[orgId]`.
 */
export async function orchestratorsUseCommand(
  clusterName: string,
  options: OrchestratorsOptions,
): Promise<boolean> {
  const ctx = await resolveOrgContext(options);
  if (!ctx) return false;

  const orchestrators = await fetchOrchestrators(ctx.config, ctx.orgId);
  if (orchestrators === null) return false;

  const match = orchestrators.find((o) => o.clusterName === clusterName);
  if (!match) {
    console.error(pc.red(`Orchestrator cluster not found: ${clusterName}`));
    const named = orchestrators.map((o) => o.clusterName).filter((n): n is string => !!n);
    if (named.length > 0) {
      console.error(pc.gray('Connected clusters:'));
      for (const n of named) console.error(pc.gray(`  - ${n}`));
    }
    return false;
  }

  const defaultClusters = { ...(ctx.config.defaultClusters ?? {}), [ctx.orgId]: clusterName };
  await mergeGlobalConfig({ defaultClusters });
  console.log(pc.green(`Default orchestrator for ${ctx.orgId} set to: ${clusterName}`));
  return true;
}
