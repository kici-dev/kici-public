/**
 * Shared helpers for orchestrator entry points (server.ts and standalone.ts).
 *
 * Extracted to eliminate code duplication between the two entry points.
 * Both entry points import these helpers instead of maintaining separate copies.
 */

import { statSync } from 'node:fs';
import { type SourceProvider, SourceSubtype } from '@kici-dev/engine';
import { LocalSourceConfigSchema } from './providers/local/local-source-config.js';

/**
 * A provider source for Platform registration.
 *
 * `provider` is the coarse-grained Platform-routing family (`github` /
 * `gitlab` / `bitbucket` / `generic`). `subtype` is the fine-grained
 * source kind that survives all the way to the dashboard so universal-git,
 * generic_webhook, and local sources stay distinguishable. `name` is
 * the human-readable label shown in the runs view + sources tab.
 */
export interface ProviderSource {
  provider: SourceProvider;
  routingKey: string;
  name: string;
  subtype: SourceSubtype;
}

/**
 * Map a generic_webhook_sources `provider_type` (plus optional `git_config`
 * presence) to the canonical {@link SourceSubtype}.
 *
 * Single source of truth for the orchestrator-side mapping — both the
 * boot-time bulk registration (`server.ts`) and any future per-source
 * register/update path (`platform-client.ts`) go through here so the
 * subtype emitted to Platform stays consistent with what the dashboard
 * eventually renders.
 */
export function genericProviderTypeToSubtype(
  providerType: string,
  options: { hasGitConfig: boolean },
): SourceSubtype {
  if (providerType === 'local') return SourceSubtype.enum.local;
  if (options.hasGitConfig) return SourceSubtype.enum.universal_git;
  if (providerType === 'universal-git') return SourceSubtype.enum.universal_git;
  return SourceSubtype.enum.generic_webhook;
}

/**
 * Extract repo identifier (owner/repo) from a git clone URL.
 * e.g., "https://github.com/myorg/myrepo.git" -> "myorg/myrepo"
 */
export function extractRepoIdentifier(repoUrl: string): string {
  // Match provider URLs: github.com/owner/repo, gitlab.com/namespace/project, etc.
  const match = repoUrl.match(/(?:github|gitlab|bitbucket)\.\w+\/([^/]+\/[^/.]+)/);
  return match ? match[1] : 'unknown/unknown';
}

/**
 * Diff two provider source arrays by routingKey.
 * Returns which sources were added and which were removed.
 *
 * Used during config reload to determine which source.register and
 * source.deregister messages to send.
 */
export function diffProviderSources(
  oldSources: ProviderSource[],
  newSources: ProviderSource[],
): { added: ProviderSource[]; removed: ProviderSource[] } {
  const oldKeys = new Set(oldSources.map((s) => s.routingKey));
  const newKeys = new Set(newSources.map((s) => s.routingKey));

  const added = newSources.filter((s) => !oldKeys.has(s.routingKey));
  const removed = oldSources.filter((s) => !newKeys.has(s.routingKey));

  return { added, removed };
}

/**
 * Decide whether the local orchestrator can serve a `generic_webhook_sources`
 * row with the given `provider_type`. Used at boot (and any future reload) to
 * filter the source.register payload sent to Platform — if a peer can't serve
 * the row, advertising it would invite Platform's least-loaded relay to pick
 * this peer and drop the webhook silently in a pipeline whose lock-file
 * fetcher returns null.
 *
 * - `'generic'` / `'universal-git'` → always servable (the bundles register
 *   without filesystem dependencies; per-row failures during universal-git
 *   bundle registration are already isolated in orchestrator-core.ts).
 * - `'local'` → only servable when the ROW's own `git_config.repoBasePath`
 *   exists as a directory on THIS peer. The check is per-source and per-peer:
 *   a local repo present on one HA peer may be absent on another, so only the
 *   peer that hosts the repo advertises the routing key. Mirrors the statSync
 *   gate in `registerProviderBundleForSource`.
 * - Any unknown provider_type returns false to fail closed.
 */
export function canServeGenericProviderType(
  providerType: string,
  gitConfig?: string | Record<string, unknown> | null,
): boolean {
  if (providerType === 'generic' || providerType === 'universal-git') return true;
  if (providerType === 'local') {
    const raw = typeof gitConfig === 'string' ? safeJsonParse(gitConfig) : gitConfig;
    const parsed = LocalSourceConfigSchema.safeParse(raw);
    if (!parsed.success) return false;
    try {
      return statSync(parsed.data.repoBasePath).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/** Parse JSON, returning null on any error (the `git_config` column is dual-purpose). */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
