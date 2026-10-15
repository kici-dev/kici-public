/**
 * `kici orchestrators`: `list` reads the Platform orchestrators index; `use
 * <name>` records `config.defaultClusters[orgId]`, the per-org default `kici run
 * remote` uses when no `--orchestrator` flag is given.
 */

import pc from 'picocolors';
import { loadGlobalConfig, mergeGlobalConfig, type GlobalConfig } from '../remote/config.js';

export interface OrchestratorsOptions {
  /** Overrides config.activeOrgId. */
  org?: string;
}

interface OrchestratorEntry {
  clusterName: string | null;
  routingKeys: string[];
  orchVersion: string | null;
}

/** Prints an actionable error and returns null when the login or org is missing. */
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

/** Returns null, after printing an error, on an auth or HTTP failure. */
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

/** Validates the name against the org's connected clusters before saving it. */
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
