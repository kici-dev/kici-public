import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { SourceManager } from './source-manager.js';
import type { ProviderSource } from '../entry-helpers.js';
import { canServeGenericProviderType, genericProviderTypeToSubtype } from '../entry-helpers.js';

const logger = createLogger({ prefix: 'platform-sources' });

/** One active generic-webhook routing-key row (subset consumed here). */
export interface GenericRoutingKeyRow {
  routing_key: string;
  provider_type: string;
  name: string;
  has_git_config: boolean;
  /** Raw `git_config` JSONB — used to check a local source's per-row
   *  `repoBasePath` reachability before advertising its routing key. */
  git_config: string | Record<string, unknown> | null;
}

/**
 * Build the full provider-source list the orchestrator advertises to the
 * Platform: GitHub-app sources from the {@link SourceManager} plus every
 * *servable* generic-webhook source.
 *
 * Used both at boot and by the live republish closure (platform mode). It MUST
 * return the complete set every time — a live source change re-sends the whole
 * list via `platformClient.updateSources()`, which diffs against the previously
 * sent set; a partial list would make the Platform deregister the sources that
 * happened to be omitted.
 *
 * The generic-row loader is injected (rather than taking a `db`) so the merge
 * logic is unit-testable without a live database.
 */
export async function buildPlatformProviderSources(
  sourceManager: Pick<SourceManager, 'getSources'>,
  loadGenericRows: () => Promise<GenericRoutingKeyRow[]>,
): Promise<ProviderSource[]> {
  const providerSources: ProviderSource[] = [...sourceManager.getSources()];
  try {
    const genericRows = await loadGenericRows();
    const skipped: Array<{ routing_key: string; provider_type: string }> = [];
    for (const gs of genericRows) {
      // Claim only what this peer can serve — a peer whose filesystem does not
      // host a local source's repoBasePath must not advertise that routing key.
      if (canServeGenericProviderType(gs.provider_type, gs.git_config)) {
        providerSources.push({
          provider: 'generic',
          routingKey: gs.routing_key,
          name: gs.name,
          subtype: genericProviderTypeToSubtype(gs.provider_type, {
            hasGitConfig: gs.has_git_config,
          }),
        });
      } else {
        skipped.push({ routing_key: gs.routing_key, provider_type: gs.provider_type });
      }
    }
    if (genericRows.length > 0) {
      logger.info('Added generic sources to Platform registration', {
        count: genericRows.length - skipped.length,
        skipped: skipped.length,
      });
    }
    if (skipped.length > 0) {
      logger.info('Skipped non-servable generic sources for Platform registration', { skipped });
    }
  } catch (err) {
    logger.warn('Failed to load generic sources for Platform registration', {
      error: toErrorMessage(err),
    });
  }
  return providerSources;
}
