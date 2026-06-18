/**
 * Source-create gate tripwires.
 *
 * Two invariants protect the orchestrator from registering arbitrary
 * GitHub Apps as sources without proof of ownership:
 *
 *  1. The handler calls `validateGitHubSource(appId, privateKey)` BEFORE
 *     `sourceStore.addSource(...)`. If validation rejects (the appId +
 *     privateKey pair fails GitHub's `GET /app` JWT auth — i.e., the
 *     caller does not actually possess the App's private key), the
 *     handler returns 400 and the source is NOT persisted. Removing
 *     this gate would let an external (A1) or operator-token-holder
 *     (A10) attacker register a source for ANY GitHub App by App ID
 *     alone, then receive webhooks meant for that App's installations
 *     and resolve secrets against repo names that match its triggers.
 *
 *  2. The routing key is SERVER-DERIVED from the validated `appId`
 *     (`${provider}:${appId}` — see `source-store.ts:addSource`). The
 *     handler at `admin-sources.ts` does NOT read `routingKey` from
 *     the request body. A request that includes a forged
 *     `routingKey: 'github:victim-appid'` MUST be ignored — the
 *     persisted row's routing_key MUST equal the server-derived value
 *     based on the caller-submitted `appId`. Removing this gate would
 *     let a caller squat an arbitrary routing key (e.g.,
 *     `github:99999`) and intercept webhooks routed by that key.
 *
 * Trust model (must hold):
 *   For attacker model A1 (external, unauthenticated) and A10 (stolen
 *   admin token), the source-create handler's pre-DB validate call is
 *   the cryptographic gate that requires proof of GitHub App
 *   ownership. The webhook-routing layer (§2.4 + §2.5) layers on top
 *   of this — but if the source-create gate were bypassed, an attacker
 *   could register the victim App's ID with their own private key and
 *   later... well, they couldn't, because validateGitHubSource calls
 *   `GET /app` and that request fails without the real private key.
 *   The point of THIS test is that the gate is invoked at all, in
 *   the right order. A future refactor that moved validation AFTER
 *   the addSource call (e.g., as part of a post-write enrichment
 *   step) would silently widen the attack surface. This test keeps
 *   the call order honest.
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

describe('§4.4 source-create gate invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cryptographic ownership gate (validateGitHubSource → addSource ordering)', () => {
    it('REJECTS the request and does NOT persist when validateGitHubSource fails', async () => {
      // Simulate the gate firing — invalid appId + privateKey pair.
      // Real validator would call `GET /app` and fail because the
      // caller doesn't have the App's actual private key.
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

      // The critical invariant: addSource MUST NOT have been called.
      // A future refactor that persisted-then-validated, or that
      // ignored validator failures, would fail this assertion.
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

      // The validator was called BEFORE addSource — assert ordering by
      // checking both invocation orders.
      expect(vi.mocked(sourceValidator.validateGitHubSource)).toHaveBeenCalledTimes(1);
      expect(addSource).toHaveBeenCalledTimes(1);

      const validatorCallOrder = vi.mocked(sourceValidator.validateGitHubSource).mock
        .invocationCallOrder[0];
      const addSourceCallOrder = addSource.mock.invocationCallOrder[0];
      expect(validatorCallOrder).toBeLessThan(addSourceCallOrder);
    });

    it('REJECTS when required fields are missing (no validator/addSource invocation)', async () => {
      // Defense-in-depth: the handler validates required fields before
      // even calling validateGitHubSource. An attacker who omits the
      // privateKey can't trick the handler into treating the source as
      // "validated" by skipping the gate entirely.
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

      // The attacker's body includes a forged `routingKey` pointing at
      // a victim's appId (`99999`). The handler MUST NOT pass this
      // value through to addSource — addSource derives the routing
      // key server-side from `appId` (which is `42`).
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
      // The handler MUST NOT forward `routingKey` to the store. The
      // store computes it from `appId`. If the handler grew a
      // `routingKey: body.routingKey` line, this assertion fails.
      expect(callArg).not.toHaveProperty('routingKey');
      // Caller's appId (which the validator approved) is what the
      // store will use to derive the routing key.
      expect(callArg.appId).toBe('42');
    });
  });
});
