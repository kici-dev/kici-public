import { describe, it, expect, vi } from 'vitest';
import { OrchestratorMode } from '@kici-dev/engine';
import {
  resolveAddedGithubSourceUrl,
  resolveManifestGithubWebhookUrl,
  resolveListedGithubIngressUrl,
} from './webhook-url-resolvers.js';

const BASE = 'https://ci.example.com';
const PLATFORM_URL = 'https://api.kici.dev/webhook/org_a/github';
const PLATFORM_ACK_URL = 'https://api.kici.dev/webhook/org_a/github';

describe('resolveAddedGithubSourceUrl', () => {
  const base = {
    webhookPublicUrl: BASE,
    orgId: 'org_a',
    sourceId: 'src-1',
    onRegisterError: vi.fn(),
  };

  // fails-when: observed mode still prefers the ack's Platform URL.
  it('observed: returns its own per-source URL even when the ack carries a Platform URL', async () => {
    const registerAndAwait = vi.fn(async () => PLATFORM_ACK_URL);
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.observed,
      registerAndAwait,
    });
    expect(r).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_a/github/src-1' });
    // The push still runs: it is the live propagation of the add.
    expect(registerAndAwait).toHaveBeenCalledOnce();
  });

  it('observed: still returns its own URL when the Platform push fails', async () => {
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.observed,
      registerAndAwait: vi.fn(async () => {
        throw new Error('disconnected');
      }),
    });
    expect(r).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_a/github/src-1' });
  });

  // breaks-if-wrong: hybrid keeps relay-first behaviour.
  it('hybrid: returns the ack URL', async () => {
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.hybrid,
      registerAndAwait: vi.fn(async () => PLATFORM_ACK_URL),
    });
    expect(r).toEqual({ webhookUrl: PLATFORM_ACK_URL });
  });

  it('hybrid: falls back to its own URL when the ack carries none', async () => {
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.hybrid,
      registerAndAwait: vi.fn(async () => null),
    });
    expect(r).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_a/github/src-1' });
  });

  // fails-when: platform mode falls back to its own URL, which it never serves
  //   (the direct GitHub route is mounted only in the own-ingress modes).
  // breaks-if-wrong: hybrid still falls back to its own URL (test above).
  it('platform: an ack without a URL is platform-no-public-url, never its own URL', async () => {
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.platform,
      registerAndAwait: vi.fn(async () => null),
    });
    expect(r).toEqual({ webhookUrl: null, webhookNote: 'platform-no-public-url' });
  });

  it('platform: a failed push is platform-unavailable', async () => {
    const r = await resolveAddedGithubSourceUrl({
      ...base,
      mode: OrchestratorMode.enum.platform,
      registerAndAwait: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    expect(r).toEqual({ webhookUrl: null, webhookNote: 'platform-unavailable' });
  });
});

describe('resolveManifestGithubWebhookUrl', () => {
  const input = { webhookPublicUrl: BASE, orgId: 'org_a', platformGithubWebhookUrl: PLATFORM_URL };

  it('platform: the Platform URL from auth.success', () => {
    expect(
      resolveManifestGithubWebhookUrl({ ...input, mode: OrchestratorMode.enum.platform }),
    ).toEqual({ webhookUrl: PLATFORM_URL });
  });

  // fails-when: platform mode still needs KICI_WEBHOOK_PUBLIC_URL.
  it('platform: never builds from KICI_WEBHOOK_PUBLIC_URL; unknown without the field', () => {
    expect(
      resolveManifestGithubWebhookUrl({
        ...input,
        mode: OrchestratorMode.enum.platform,
        platformGithubWebhookUrl: undefined,
      }),
    ).toEqual({ webhookUrl: null, webhookNote: 'platform-url-unknown' });
    expect(
      resolveManifestGithubWebhookUrl({
        ...input,
        mode: OrchestratorMode.enum.platform,
        platformGithubWebhookUrl: null,
      }),
    ).toEqual({ webhookUrl: null, webhookNote: 'platform-url-unknown' });
  });

  it('hybrid: the Platform URL first, then its own org-scoped URL', () => {
    expect(
      resolveManifestGithubWebhookUrl({ ...input, mode: OrchestratorMode.enum.hybrid }),
    ).toEqual({
      webhookUrl: PLATFORM_URL,
    });
    expect(
      resolveManifestGithubWebhookUrl({
        ...input,
        mode: OrchestratorMode.enum.hybrid,
        platformGithubWebhookUrl: undefined,
      }),
    ).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_a/github' });
    expect(
      resolveManifestGithubWebhookUrl({
        mode: OrchestratorMode.enum.hybrid,
        webhookPublicUrl: undefined,
        orgId: 'org_a',
        platformGithubWebhookUrl: undefined,
      }),
    ).toEqual({ webhookUrl: null, webhookNote: 'platform-url-unknown' });
  });

  // breaks-if-wrong: observed never bakes the Platform URL, even when auth.success has one.
  it('observed: its own org-scoped URL, never the Platform URL', () => {
    expect(
      resolveManifestGithubWebhookUrl({ ...input, mode: OrchestratorMode.enum.observed }),
    ).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_a/github' });
    expect(
      resolveManifestGithubWebhookUrl({
        ...input,
        mode: OrchestratorMode.enum.observed,
        orgId: undefined,
      }),
    ).toEqual({ webhookUrl: null, webhookNote: 'org-not-identified' });
  });

  // fails-when: independent mode still answers org-not-identified.
  it('independent: <base>/webhook/__default__/github, or no-public-url', () => {
    expect(
      resolveManifestGithubWebhookUrl({
        mode: OrchestratorMode.enum.independent,
        webhookPublicUrl: BASE,
        orgId: undefined,
        platformGithubWebhookUrl: undefined,
      }),
    ).toEqual({ webhookUrl: 'https://ci.example.com/webhook/__default__/github' });
    expect(
      resolveManifestGithubWebhookUrl({
        mode: OrchestratorMode.enum.independent,
        webhookPublicUrl: undefined,
        orgId: undefined,
        platformGithubWebhookUrl: undefined,
      }),
    ).toEqual({ webhookUrl: null, webhookNote: 'no-public-url' });
  });
});

describe('resolveListedGithubIngressUrl', () => {
  it('builds the per-source URL in the own-ingress modes', () => {
    for (const mode of ['hybrid', 'observed', 'independent'] as const) {
      expect(
        resolveListedGithubIngressUrl({
          mode,
          webhookPublicUrl: BASE,
          orgId: 'org_a',
          sourceId: 's1',
        }),
      ).toBe('https://ci.example.com/webhook/org_a/github/s1');
    }
  });

  it('is null in platform mode, with no public base, or with no org', () => {
    expect(
      resolveListedGithubIngressUrl({
        mode: 'platform',
        webhookPublicUrl: BASE,
        orgId: 'org_a',
        sourceId: 's1',
      }),
    ).toBeNull();
    expect(
      resolveListedGithubIngressUrl({
        mode: 'observed',
        webhookPublicUrl: undefined,
        orgId: 'org_a',
        sourceId: 's1',
      }),
    ).toBeNull();
    expect(
      resolveListedGithubIngressUrl({
        mode: 'observed',
        webhookPublicUrl: BASE,
        orgId: undefined,
        sourceId: 's1',
      }),
    ).toBeNull();
  });
});
