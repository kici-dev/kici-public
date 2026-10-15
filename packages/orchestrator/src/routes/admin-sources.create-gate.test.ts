/**
 * Source-create gate tripwires: two invariants stop the orchestrator
 * registering arbitrary GitHub Apps as sources without proof of ownership.
 *
 *  1. The handler calls `validateGitHubSource(appId, privateKey)` BEFORE
 *     `sourceStore.addSource(...)`. If the pair fails GitHub's `GET /app` JWT
 *     auth (the caller lacks the App's private key), it returns 400 and
 *     persists nothing. Without this gate an external attacker, or one holding
 *     an operator token, could register a source for ANY GitHub App by App ID
 *     alone, receive webhooks meant for its installations, and resolve secrets
 *     against repo names that match its triggers.
 *
 *  2. The routing key is SERVER-DERIVED from the validated `appId`
 *     (`${provider}:${appId}`, see `source-store.ts:addSource`);
 *     `admin-sources.ts` never reads `routingKey` from the body. A forged
 *     `routingKey: 'github:victim-appid'` MUST be ignored, else a caller could
 *     squat any routing key (e.g. `github:99999`) and intercept its webhooks.
 *
 * Trust model (must hold): for an external unauthenticated attacker and for
 * one holding a stolen admin token, the pre-DB validate call is the
 * cryptographic proof of GitHub App ownership; the webhook-routing layer sits
 * on top. `GET /app` fails without the real private key, so THIS test only
 * pins that the gate runs at all, in the right order: moving validation AFTER
 * addSource (e.g. as a post-write enrichment step) would silently widen the
 * attack surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSourceRoutes } from './admin-sources.js';
import type { SourceStore } from '../sources/source-store.js';
import * as sourceValidator from '../sources/source-validator.js';

vi.mock('../sources/source-validator.js', () => ({
  validateGitHubSource: vi.fn(),
}));

function createMockSourceStore(overrides?: Partial<SourceStore>): SourceStore {
  return {
    addSource: vi.fn(),
    listSources: vi.fn().mockResolvedValue([]),
    getSource: vi.fn().mockResolvedValue(null),
    getSourceWithSecrets: vi.fn().mockResolvedValue(null),
    updateSource: vi.fn(),
    removeSource: vi.fn(),
    ...overrides,
  } as unknown as SourceStore;
}

describe('source-create gate invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cryptographic ownership gate (validateGitHubSource → addSource ordering)', () => {
    it('REJECTS the request and does NOT persist when validateGitHubSource fails', async () => {
      // The real validator's `GET /app` fails without the App's private key.
      vi.mocked(sourceValidator.validateGitHubSource).mockResolvedValueOnce({
        valid: false,
        error: 'GitHub API validation failed: bad credentials',
      });

      const addSource = vi.fn();
      const sourceStore = createMockSourceStore({ addSource });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          name: 'forged-source',
          appId: '99999', // pretend this is a victim's App ID
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
          webhookSecret: 'whatever',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('GitHub API validation failed');

      // Fails if the handler persists then validates, or ignores a validator failure.
      expect(addSource).not.toHaveBeenCalled();
    });

    it('persists ONLY after validateGitHubSource succeeds', async () => {
      vi.mocked(sourceValidator.validateGitHubSource).mockResolvedValueOnce({
        valid: true,
        appName: 'Legitimate App',
      });

      const addSource = vi.fn().mockResolvedValue({
        id: 's1',
        routing_key: 'github:42',
        name: 'legit-source',
      });
      const sourceStore = createMockSourceStore({ addSource });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          name: 'legit-source',
          appId: '42',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nLEGIT\n-----END RSA PRIVATE KEY-----',
          webhookSecret: 'wh-secret',
        }),
      });

      expect(res.status).toBe(201);

      expect(vi.mocked(sourceValidator.validateGitHubSource)).toHaveBeenCalledTimes(1);
      expect(addSource).toHaveBeenCalledTimes(1);

      const validatorCallOrder = vi.mocked(sourceValidator.validateGitHubSource).mock
        .invocationCallOrder[0];
      const addSourceCallOrder = addSource.mock.invocationCallOrder[0];
      expect(validatorCallOrder).toBeLessThan(addSourceCallOrder);
    });

    it('REJECTS when required fields are missing (no validator/addSource invocation)', async () => {
      // Defense-in-depth: required fields are checked before validateGitHubSource,
      // so omitting privateKey cannot skip the gate and count as "validated".
      const addSource = vi.fn();
      const sourceStore = createMockSourceStore({ addSource });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          name: 'partial-source',
          appId: '42',
          // privateKey omitted on purpose
        }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(sourceValidator.validateGitHubSource)).not.toHaveBeenCalled();
      expect(addSource).not.toHaveBeenCalled();
    });
  });

  describe('routing key is server-derived (no client-side squatting)', () => {
    it('IGNORES a forged `routingKey` in the request body — addSource receives only the validated appId', async () => {
      vi.mocked(sourceValidator.validateGitHubSource).mockResolvedValueOnce({
        valid: true,
        appName: 'Legitimate App',
      });

      const addSource = vi.fn().mockResolvedValue({
        id: 's1',
        routing_key: 'github:42',
        name: 'legit-source',
      });
      const sourceStore = createMockSourceStore({ addSource });
      const app = createSourceRoutes({ sourceStore });

      // A forged `routingKey` names a victim's appId (`99999`); addSource
      // derives the key server-side from `appId` (`42`).
      const res = await app.request('/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          name: 'forged-routing-key',
          appId: '42',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nLEGIT\n-----END RSA PRIVATE KEY-----',
          webhookSecret: 'wh',
          routingKey: 'github:99999', // forged — must be ignored
        }),
      });

      expect(res.status).toBe(201);
      expect(addSource).toHaveBeenCalledTimes(1);

      const callArg = addSource.mock.calls[0][0];
      // Fails if the handler forwards `routingKey: body.routingKey` to the store.
      expect(callArg).not.toHaveProperty('routingKey');
      // The store derives the key from the validator-approved appId.
      expect(callArg.appId).toBe('42');
    });
  });
});

describe('GitHub-App source creation in observed mode', () => {
  beforeEach(() => vi.clearAllMocks());

  // fails-when: the observed 400 gate exists.
  // breaks-if-wrong: an invalid key still answers the validator's 400 (the
  //   ownership-gate test above), so the mode change opens no bypass.
  it('validates credentials and creates the source', async () => {
    vi.mocked(sourceValidator.validateGitHubSource).mockResolvedValueOnce({
      valid: true,
      appName: 'Legitimate App',
    });
    const addSource = vi.fn().mockResolvedValue({ id: 's1', routing_key: 'github:42', name: 'x' });
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore({ addSource }),
    });
    const res = await app.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        name: 'observed-source',
        appId: '42',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nLEGIT\n-----END RSA PRIVATE KEY-----',
        webhookSecret: 'wh-secret',
      }),
    });
    expect(res.status).toBe(201);
    expect(sourceValidator.validateGitHubSource).toHaveBeenCalledWith('42', expect.any(String));
    expect(addSource).toHaveBeenCalledTimes(1);
  });
});
