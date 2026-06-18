/**
 * Universal-git provider bundle factory + barrel re-exports.
 *
 * A universal-git source is a `generic_webhook_sources` row with a non-null
 * `git_config` column. At startup (and on config reload) the orchestrator
 * walks every such row and calls `createUniversalGitProviderBundle()` to
 * register a ProviderBundle under the source's routing key.
 *
 * Classes:
 *   - `UniversalGitWebhookNormalizer` — normalizes push/PR payloads for any
 *     forge whose webhook body is declared via JSONPath (`payloadPaths`).
 *   - `UniversalGitLockFileFetcher` — shallow-clones the repo, sparse on
 *     `.kici/`, reads `kici.lock.json` (5 MiB cap, 30 s budget).
 *   - `UniversalGitChangedFilesFetcher` — extracts `commits[]` diffs via
 *     JSONPath; no REST call.
 *   - `UniversalGitCloneTokenProvider` — resolves the source-scoped secret
 *     and returns the raw PAT/Basic/SSH material.
 *   - `UniversalGitRepoUrlBuilder` — substitutes `{owner}`/`{name}`/`{repo}`
 *     in the source's `gitUrlTemplate`.
 *
 * No `ContributorResolver` or `CheckStatusPoster` is wired for v1 — forge
 * API support for those is uneven and adding it is a separate phase.
 */

import type { ProviderBundle } from '../../provider-registry.js';
import type { GenericWebhookSource } from '../../db/types.js';
import type { SecretResolver } from '../../secrets/secret-resolver.js';
import { safeParseUniversalGitConfig, type UniversalGitConfig } from './config.js';
import { UniversalGitWebhookNormalizer } from './normalizer.js';
import { UniversalGitLockFileFetcher } from './lock-file.js';
import { UniversalGitChangedFilesFetcher } from './changed-files.js';
import { UniversalGitCloneTokenProvider } from './clone-token.js';
import { UniversalGitRepoUrlBuilder } from './repo-url.js';

export { UniversalGitWebhookNormalizer } from './normalizer.js';
export { UniversalGitLockFileFetcher, LockFileTooLargeError } from './lock-file.js';
export { UniversalGitChangedFilesFetcher } from './changed-files.js';
export { UniversalGitCloneTokenProvider, type UniversalGitAuth } from './clone-token.js';
export { UniversalGitRepoUrlBuilder, splitRepoIdentifier } from './repo-url.js';
export {
  prepareSshAuth,
  prepareSshAuthSync,
  composeGitSshCommand,
  type SshAuthArtefacts,
  type SshAuthArtefactsSync,
  type PrepareSshAuthOptions,
} from './ssh-auth.js';
export {
  UniversalGitConfigSchema,
  parseUniversalGitConfig,
  safeParseUniversalGitConfig,
  expandUniversalGitConfig,
  presetWebhookEventHeader,
  UNIVERSAL_GIT_PRESETS,
  type UniversalGitConfig,
  type UniversalGitPreset,
  type UniversalGitCredentialType,
  type CredentialRef,
} from './config.js';

/**
 * Normalize a `generic_webhook_sources` row's `git_config` into a parsed
 * `UniversalGitConfig`. The column is `ColumnType<string | Record<...> |
 * null, ...>` so it can arrive as either a JSON string (when the DB driver
 * hasn't auto-parsed JSONB) or a plain object (when it has).
 */
export function parseSourceGitConfig(
  raw: string | Record<string, unknown> | null | undefined,
): UniversalGitConfig | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const result = safeParseUniversalGitConfig(value);
  if (!result.ok) {
    throw new Error(
      `Invalid universal-git config in generic_webhook_sources.git_config: ${result.error.message}`,
    );
  }
  return result.config;
}

/**
 * Build a complete `ProviderBundle` for one universal-git source.
 *
 * The caller is responsible for invoking this at startup + config reload
 * for every `generic_webhook_sources` row whose `git_config` is non-null,
 * and for (un)registering the bundle against `providerRegistry` under the
 * source's routing key (format: `generic:<orgId>:<sourceId>`).
 *
 * Returns `null` when the source has no `git_config` (i.e. it is a plain
 * generic webhook, not a universal-git source) — callers can rely on this
 * to differentiate the two shapes without re-parsing the row.
 */
export function createUniversalGitProviderBundle(
  source: Pick<GenericWebhookSource, 'id' | 'customer_id' | 'routing_key' | 'git_config'>,
  secretResolver: SecretResolver,
): ProviderBundle | null {
  const config = parseSourceGitConfig(source.git_config ?? null);
  if (!config) return null;

  const orgId = source.customer_id;
  const sourceId = source.id;

  return {
    normalizer: new UniversalGitWebhookNormalizer({
      routingKey: source.routing_key,
      config,
    }),
    lockFileFetcher: new UniversalGitLockFileFetcher({
      orgId,
      sourceId,
      config,
      secretResolver,
    }),
    changedFilesFetcher: new UniversalGitChangedFilesFetcher({ config }),
    cloneTokenProvider: new UniversalGitCloneTokenProvider({
      orgId,
      sourceId,
      config,
      secretResolver,
    }),
    repoUrlBuilder: new UniversalGitRepoUrlBuilder(config.gitUrlTemplate),
  };
}
