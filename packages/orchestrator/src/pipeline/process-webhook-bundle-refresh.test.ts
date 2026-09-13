import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import { ProviderRegistry, type ProviderBundle } from '../provider-registry.js';
import type { WebhookInfo } from '../webhook/handler.js';

/**
 * A delivery for a generic source whose own provider bundle is missing from
 * the registry.
 *
 * The registry is an in-memory cache of `generic_webhook_sources`, written by
 * three paths that are all on the WRITE side (startup enumeration, the admin
 * handler, the LISTEN/NOTIFY drain). None of them can promise the entry is
 * present at the moment a delivery arrives, and the miss used to be silent:
 * the lookup fell back to the shared `generic:default` bundle, whose
 * normalizer reports every payload as carrying no repository, so the pipeline
 * dropped the delivery at its no-repo exit. Observed on staging as a
 * repo-bearing `push` answered 202 and recorded only as `received` with
 * `matched_count = 0` — no run, no dispatch, and nothing above `debug` to say
 * why.
 */
const ROUTING_KEY = 'generic:org-1:source-1';

function makeBundle(
  provider: 'generic' | 'local',
  extractRepoIdentifier: () => string | null,
): ProviderBundle {
  return {
    normalizer: {
      provider,
      extractRoutingKey: vi.fn(),
      extractDeliveryId: vi.fn(),
      extractEventType: vi.fn(),
      verifySignature: vi.fn(),
      normalizeEvent: vi.fn(() => ({
        type: 'push',
        targetBranch: 'master',
        payload: {},
        provider,
      })),
      extractRepoIdentifier: vi.fn(extractRepoIdentifier),
      extractRef: vi.fn(() => 'HEAD'),
      extractCredentials: vi.fn(() => ({})),
    },
    lockFileFetcher: { provider, fetchLockFile: vi.fn() },
    changedFilesFetcher: { provider, getChangedFiles: vi.fn() },
    cloneTokenProvider: { provider, createCloneToken: vi.fn() },
    repoUrlBuilder: { provider, buildCloneUrl: vi.fn(), buildRawFileUrl: vi.fn() },
  } as unknown as ProviderBundle;
}

const info: WebhookInfo = {
  routingKey: ROUTING_KEY,
  deliveryId: 'delivery-1',
  event: 'push',
  action: null,
  provider: 'local',
  payload: { ref: 'refs/heads/master', repository: { full_name: 'acme/canary' } },
};

/**
 * Both bundles stop at the no-repo exit so the assertions stay on bundle
 * SELECTION — which is the defect — rather than dragging lock-file
 * resolution and dispatch into the test. Which normalizer was asked is the
 * whole question.
 */
function makeDeps(registry: ProviderRegistry, ensureProviderBundle?: () => Promise<boolean>) {
  return {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: registry,
    ...(ensureProviderBundle ? { ensureProviderBundle: vi.fn(ensureProviderBundle) } : {}),
  } as unknown as Parameters<typeof processWebhook>[1];
}

describe('processWebhook provider-bundle refresh', () => {
  it('registers the source bundle from server truth when the registry has missed it', async () => {
    const registry = new ProviderRegistry();
    const defaultBundle = makeBundle('generic', () => null);
    registry.register('generic', defaultBundle);
    const sourceBundle = makeBundle('local', () => null);

    // Stands in for the orchestrator's closure: reads the source row and
    // registers its bundle.
    const ensure = vi.fn(async () => {
      registry.registerByRoutingKey(ROUTING_KEY, sourceBundle);
      return true;
    });

    await processWebhook(info, makeDeps(registry, ensure));

    expect(ensure).toHaveBeenCalledTimes(1);
    // The source's own normalizer answered, not the shared default one.
    expect(sourceBundle.normalizer.extractRepoIdentifier).toHaveBeenCalled();
    expect(defaultBundle.normalizer.extractRepoIdentifier).not.toHaveBeenCalled();
  });

  it('does not refresh when the source bundle is already registered', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      'generic',
      makeBundle('generic', () => null),
    );
    registry.registerByRoutingKey(
      ROUTING_KEY,
      makeBundle('local', () => null),
    );
    const ensure = vi.fn(async () => true);

    await processWebhook(info, makeDeps(registry, ensure));

    expect(ensure).not.toHaveBeenCalled();
  });

  it('falls through to the default bundle when the source genuinely has none', async () => {
    // A plain generic source is meant to use the shared bundle, so a `false`
    // answer is the steady state and must not fail the delivery.
    const registry = new ProviderRegistry();
    const defaultBundle = makeBundle('generic', () => null);
    registry.register('generic', defaultBundle);
    const ensure = vi.fn(async () => false);

    await processWebhook(info, makeDeps(registry, ensure));

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(defaultBundle.normalizer.extractRepoIdentifier).toHaveBeenCalled();
  });

  it('leaves a github routing key alone', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      'github',
      makeBundle('generic', () => null),
    );
    const ensure = vi.fn(async () => true);

    await processWebhook({ ...info, routingKey: 'github:999' }, makeDeps(registry, ensure));

    expect(ensure).not.toHaveBeenCalled();
  });
});
