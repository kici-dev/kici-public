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
 * Final path segment of a filesystem path or a `file://` URL, splitting on both
 * POSIX and Windows separators.
 *
 * The cross-platform light bundle substitutes `import.meta.url` as
 * `` `file://${__filename}` ``. On POSIX that is a valid `file:///abs` URL, but
 * on Windows `__filename` is a backslash path with a drive letter, so the value
 * becomes `file://C:\dir\file.cjs` — which does NOT string-compare equal to
 * `pathToFileURL(argv[1]).href` (`file:///C:/dir/file.cjs`). Comparing the last
 * segment instead sidesteps every scheme (`file://` vs `file:///`) and separator
 * (`/` vs `\`) representation difference.
 */
function entryFileName(pathOrUrl: string): string {
  const withoutQueryOrHash = pathOrUrl.replace(/[?#].*$/, '');
  const segments = withoutQueryOrHash.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/**
 * Decide whether the current module load is the real production orchestrator
 * process entry and should boot the server.
 *
 * `server.ts` is shipped under several output filenames depending on the build:
 * `dist/server.js` (the native/full build and the container image) and
 * `kici-orchestrator.cjs` / `.mjs` (the cross-platform "light" bundle customers
 * download for macOS / Windows / ARM). All of them are real production entries
 * and MUST boot when run directly, so the guard cannot key on one filename.
 *
 * The one entry that inlines `server.ts` yet must NOT boot from this guard is
 * the dev-only `server-test.js`: it imports `runServer` and boots it itself with
 * a fault-injection policy, so a second boot from the inlined guard would run
 * two orchestrators in one process. That is the only exclusion, so the guard
 * fires for every process entry EXCEPT `server-test.js`.
 *
 * Matching is by final path segment (see {@link entryFileName}) rather than full
 * URL-string equality: the light bundle's `import.meta.url` is
 * `` `file://${__filename}` ``, whose Windows form (`file://C:\...`) never equals
 * the `pathToFileURL(argv[1]).href` form (`file:///C:/...`), which would leave the
 * Windows orchestrator loading and exiting 0 without ever starting the server.
 * On bare import (a unit test, or any non-entry importer) `argv[1]` is the
 * importer, whose filename differs from this module's, so the guard stays silent.
 *
 * @param argvPath  `process.argv[1]` — the path Node was invoked with.
 * @param moduleUrl `import.meta.url` of the server module.
 */
export function isProductionEntry(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  const entryName = entryFileName(argvPath);
  const moduleName = entryFileName(moduleUrl);
  return entryName.length > 0 && entryName === moduleName && moduleName !== 'server-test.js';
}

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
  /**
   * GitHub App slug (URL-safe identifier GitHub assigns). Only set for
   * GitHub-App sources, where it propagates orchestrator → Platform → dashboard
   * alongside the display `name`. Undefined for generic / universal-git / local
   * sources, and for a GitHub source whose identity fetch hasn't run yet.
   */
  slug?: string;
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
