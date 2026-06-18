/**
 * Per-source provider-bundle registration.
 *
 * Three call sites need this logic; the helper exists so they don't
 * each carry a copy of the `provider_type` / `git_config` dispatch:
 *
 *   1. `orchestrator-core.ts` startup, where it loops over every source
 *      already in `generic_webhook_sources` and registers the matching
 *      provider bundle into `ProviderRegistry`. Cold-boot path.
 *   2. The admin HTTP handlers in `admin-events.ts` —
 *      `POST /api/v1/admin/generic-sources` and the matching PATCH /
 *      DELETE / enable / disable endpoints. Calling the helper inline
 *      makes the API response self-consistent on the issuing peer (a
 *      webhook fired immediately after the 200 reaches the right
 *      normalizer without waiting for the `pg_notify` round-trip).
 *   3. `GenericSourcesChangeListener` (`webhook/generic-sources-listener.ts`),
 *      which listens for the migration-019 `pg_notify('generic_sources_change',
 *      routing_key)` and applies the change on every other peer in the
 *      HA cluster.
 *
 * `registerProviderBundleForSource` is the single source of truth. It
 * dispatches on `row.provider_type` and `row.git_config` so callers
 * don't have to know which bundle to build — they hand over the row +
 * the orchestrator's already-instantiated registry / config /
 * secret-resolver and we do the right thing.
 *
 * Failure semantics match the startup behaviour: local-only-but-
 * unservable peers log + skip (no throw); universal-git config errors
 * bump the per-row metric + log but never propagate. The caller can
 * assume "returns normally" means "the right thing happened or we
 * recorded why it didn't".
 */

import { statSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { createLocalProviderBundle } from '../providers/local/index.js';
import { LocalSourceConfigSchema } from '../providers/local/local-source-config.js';
import { createUniversalGitProviderBundle } from '../providers/universal-git/index.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { universalGitRegistrationErrorsTotal } from '../metrics/prometheus.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { GenericWebhookSource } from '../db/types.js';

const logger = createLogger({ prefix: 'register-source-bundle' });

/** Scaler backends that don't share the orchestrator host's filesystem, so a
 *  `file://` local source on them requires the repo to be baked into the agent
 *  image / rootfs. Used to emit a non-fatal reachability warning. */
const NON_HOST_FS_SCALERS = new Set(['container', 'firecracker']);

export interface RegisterSourceBundleDeps {
  providerRegistry: ProviderRegistry;
  config: AppConfig;
  /** Required for universal-git source rows. Null is allowed; rows that
   *  carry `git_config` will be skipped with a metric bump. */
  secretResolver: SecretResolver | null;
  /** Active scaler backend on this peer. When 'container' or 'firecracker', a
   *  local source registration emits a one-time reachability warning (the repo
   *  must exist inside the agent filesystem, not just on the orchestrator host). */
  scalerBackendType?: string;
  /** Sink for the scaler-coexistence warning. Defaults to the module logger;
   *  overridable in tests so the warning can be asserted without logger spying. */
  onScalerWarning?: (message: string, ctx: Record<string, unknown>) => void;
}

/**
 * Register the per-routing-key provider bundle a source row needs.
 *
 *   - `provider_type='local'`: registers a `LocalWebhookNormalizer` bundle
 *     built from the ROW's own `git_config.repoBasePath`, when that path
 *     exists as a directory on THIS peer. A peer that doesn't host the repo
 *     skips registration (and won't advertise the routing key — see
 *     `canServeGenericProviderType`). Checked BEFORE the universal-git branch
 *     because local sources also carry `git_config`.
 *   - `git_config IS NOT NULL`: registers a universal-git bundle.
 *   - everything else: no-op — the default `'generic'` bundle handles it.
 *
 * Idempotent under `ProviderRegistry.registerByRoutingKey` semantics: a
 * second call with the same routing key replaces the prior bundle.
 */
export function registerProviderBundleForSource(
  row: GenericWebhookSource,
  deps: RegisterSourceBundleDeps,
): void {
  if (row.provider_type === 'local') {
    registerLocalBundle(row, deps);
    return;
  }

  if (row.git_config !== null && row.git_config !== undefined) {
    if (!deps.secretResolver) {
      universalGitRegistrationErrorsTotal.add(1, { reason: 'no_secret_resolver' });
      logger.warn(
        'Skipping universal-git bundle registration — SecretResolver unavailable on this peer',
        { routingKey: row.routing_key, sourceName: row.name },
      );
      return;
    }
    try {
      const bundle = createUniversalGitProviderBundle(row, deps.secretResolver);
      if (!bundle) {
        universalGitRegistrationErrorsTotal.add(1, { reason: 'invalid_config' });
        logger.warn('Universal-git source missing git_config at registration', {
          routingKey: row.routing_key,
          sourceName: row.name,
        });
        return;
      }
      deps.providerRegistry.registerByRoutingKey(row.routing_key, bundle);
      logger.info('Registered universal-git provider bundle', {
        routingKey: row.routing_key,
        sourceName: row.name,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.message.includes('Invalid universal-git config')
          ? 'invalid_config'
          : 'bundle_build';
      universalGitRegistrationErrorsTotal.add(1, { reason });
      logger.warn('Failed to register universal-git provider bundle', {
        routingKey: row.routing_key,
        sourceName: row.name,
        reason,
        error: toErrorMessage(err),
      });
    }
    return;
  }

  // No per-routing-key bundle to register — the default 'generic' bundle
  // registered at startup handles plain generic sources without git_config.
}

/**
 * Register a local filesystem (`file://`) source bundle from the row's own
 * `git_config.repoBasePath`. The path must exist as a directory on THIS peer;
 * peers that don't host the repo skip silently (no throw). Emits a non-fatal
 * reachability warning when the active scaler is container / firecracker.
 */
function registerLocalBundle(row: GenericWebhookSource, deps: RegisterSourceBundleDeps): void {
  const raw = typeof row.git_config === 'string' ? safeJsonParse(row.git_config) : row.git_config;
  const parsed = LocalSourceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('Skipping local source — invalid local config', {
      routingKey: row.routing_key,
      sourceName: row.name,
      error: parsed.error.message,
    });
    return;
  }

  // The path must be reachable on THIS peer. HA peers that don't host the repo
  // simply skip; they will not advertise the routing key
  // (canServeGenericProviderType applies the same statSync check).
  let isDir = false;
  try {
    isDir = statSync(parsed.data.repoBasePath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    logger.warn('Skipping local source — repoBasePath not a directory on this peer', {
      routingKey: row.routing_key,
      sourceName: row.name,
      repoBasePath: parsed.data.repoBasePath,
    });
    return;
  }

  // Non-fatal reachability warning: on a container / firecracker scaler the
  // agent does NOT share the orchestrator host's filesystem, so the operator
  // must bake the repo into the image / rootfs (or bind-mount it). The warning
  // never blocks registration or dispatch.
  if (deps.scalerBackendType && NON_HOST_FS_SCALERS.has(deps.scalerBackendType)) {
    const warn = deps.onScalerWarning ?? ((m, ctx) => logger.warn(m, ctx));
    warn(
      `Local source registered on a ${deps.scalerBackendType} scaler — the repo path must exist ` +
        `inside the agent filesystem (baked into the image or on the rootfs). ` +
        `See docs/user/providers/local-file.md.`,
      {
        routingKey: row.routing_key,
        sourceName: row.name,
        repoBasePath: parsed.data.repoBasePath,
        scalerBackendType: deps.scalerBackendType,
      },
    );
  }

  deps.providerRegistry.registerByRoutingKey(
    row.routing_key,
    createLocalProviderBundle({
      repoBasePath: parsed.data.repoBasePath,
      cloneUrlBase: parsed.data.cloneUrlBase,
    }),
  );
  logger.info('Registered local provider bundle', {
    routingKey: row.routing_key,
    sourceName: row.name,
    repoBasePath: parsed.data.repoBasePath,
  });
}

/** Parse JSON, returning null on any error (used for the dual-purpose git_config column). */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
