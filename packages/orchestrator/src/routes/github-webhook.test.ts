import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createGithubWebhookRoutes, type GithubWebhookRoutesDeps } from './github-webhook.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SECRET = 'whsec-test';
const APP_ID = '12345';
const SOURCE_ID = 'src-uuid-1';
const ORG_ID = 'org_a';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeDeps(overrides?: Partial<GithubWebhookRoutesDeps>): {
  deps: GithubWebhookRoutesDeps;
  onWebhook: ReturnType<typeof vi.fn>;
} {
  const onWebhook = vi.fn(async (_info: WebhookInfo) => WebhookIngestOutcome.enum.processed);
  // verifyDeps is hit through verifyInboundWebhook; we supply a fake db +
  // secretStore + genericSourceManager that return the github source + secret.
  const db = {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst: async () => ({ id: SOURCE_ID }) }) }),
    }),
  };
  const secretStore = { getSecrets: async () => ({ webhookSecret: SECRET }) };
  const deps: GithubWebhookRoutesDeps = {
    sourceStore: {
      getSourceById: async (id: string) =>
        id === SOURCE_ID
          ? {
              id: SOURCE_ID,
              provider: 'github',
              routing_key: `github:${APP_ID}`,
              customer_id: ORG_ID,
              name: 'a',
              config: {},
            }
          : null,
      getSource: async (routingKey: string) =>
        routingKey === `github:${APP_ID}`
          ? {
              id: SOURCE_ID,
              provider: 'github',
              routing_key: `github:${APP_ID}`,
              customer_id: ORG_ID,
              name: 'a',
              config: {},
            }
          : null,
    } as never,
    verifyDeps: { db, secretStore, genericSourceManager: {} } as never,
    onWebhook,
    ...overrides,
  };
  return { deps, onWebhook };
}

async function post(
  app: ReturnType<typeof createGithubWebhookRoutes>,
  opts: { sourceId?: string; body: string; headers: Record<string, string> },
) {
  return app.request(`/webhook/${ORG_ID}/github/${opts.sourceId ?? SOURCE_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body,
  });
}

describe('createGithubWebhookRoutes', () => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' } });

  it('accepts a signed delivery WITH App installation-target headers (App-level repoint)', async () => {
    const { deps, onWebhook } = makeDeps();
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-1',
        'x-github-event': 'pull_request',
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': APP_ID,
      },
    });
    expect(res.status).toBe(202);
    expect(onWebhook).toHaveBeenCalledTimes(1);
    const info = onWebhook.mock.calls[0]![0] as WebhookInfo;
    expect(info.provider).toBe('github');
    expect(info.routingKey).toBe(`github:${APP_ID}`);
    expect(info.deliveryId).toBe('d-1');
    expect(info.event).toBe('pull_request');
    expect(info.action).toBe('opened');
  });

  it('accepts a signed delivery WITHOUT App headers (classic per-repo webhook)', async () => {
    const { deps, onWebhook } = makeDeps();
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-2',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(202);
    expect(onWebhook).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature with 401', async () => {
    const { deps, onWebhook } = makeDeps();
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-delivery': 'd-3',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(401);
    expect(onWebhook).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown source id', async () => {
    const { deps } = makeDeps();
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      sourceId: 'does-not-exist',
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-4',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when App header app-id mismatches the source routing key', async () => {
    const { deps } = makeDeps();
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-5',
        'x-github-event': 'push',
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': '99999',
      },
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 { duplicate: true } when the pipeline reports a duplicate', async () => {
    const onWebhook = vi.fn(async () => WebhookIngestOutcome.enum.duplicate);
    const { deps } = makeDeps({ onWebhook });
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-6',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
  });

  it('returns 429 + Retry-After when the pipeline sheds (admission control)', async () => {
    const onWebhook = vi.fn(async () => WebhookIngestOutcome.enum.shed);
    const { deps } = makeDeps({ onWebhook });
    const app = createGithubWebhookRoutes(deps);
    const res = await post(app, {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'd-7',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ rejected: true });
  });

  describe('cluster_settings max_github_payload_bytes', () => {
    it('rejects a body over the cluster cap with 413 (never reaches the handler)', async () => {
      const clusterSettings = {
        getNumber: async (_col: string, _fallback: number) => 10, // 10-byte cap
      } as never;
      const { deps, onWebhook } = makeDeps({
        clusterSettings,
        maxGithubPayloadBytes: 25 * 1024 * 1024,
      });
      const app = createGithubWebhookRoutes(deps);
      const res = await post(app, {
        body, // > 10 bytes
        headers: {
          'x-hub-signature-256': sign(body),
          'x-github-delivery': 'd',
          'x-github-event': 'push',
        },
      });
      expect(res.status).toBe(413);
      expect(onWebhook).not.toHaveBeenCalled();
    });

    it('accepts a body under the cluster cap (reaches the pipeline)', async () => {
      const clusterSettings = {
        getNumber: async (_col: string, fallback: number) => fallback, // null override → config default
      } as never;
      const { deps, onWebhook } = makeDeps({
        clusterSettings,
        maxGithubPayloadBytes: 25 * 1024 * 1024,
      });
      const app = createGithubWebhookRoutes(deps);
      const res = await post(app, {
        body,
        headers: {
          'x-hub-signature-256': sign(body),
          'x-github-delivery': 'd2',
          'x-github-event': 'push',
        },
      });
      expect(res.status).toBe(202);
      expect(onWebhook).toHaveBeenCalledOnce();
    });
  });
});

async function postOrgScoped(
  app: ReturnType<typeof createGithubWebhookRoutes>,
  opts: { body: string; headers: Record<string, string> },
) {
  return app.request(`/webhook/${ORG_ID}/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body,
  });
}

function appHeaders(deliveryId: string, appId = APP_ID): Record<string, string> {
  return {
    'x-github-delivery': deliveryId,
    'x-github-event': 'push',
    'x-github-hook-installation-target-type': 'integration',
    'x-github-hook-installation-target-id': appId,
  };
}

describe('org-scoped route POST /webhook/:orgId/github', () => {
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'o/r' } });

  // fails-when: the route is missing (404 from the framework) or maps the
  //   target id to the wrong routing key.
  it('accepts a signed App delivery and resolves the source by App id', async () => {
    const { deps, onWebhook } = makeDeps();
    const res = await postOrgScoped(createGithubWebhookRoutes(deps), {
      body,
      headers: { 'x-hub-signature-256': sign(body), ...appHeaders('o-1') },
    });
    expect(res.status).toBe(202);
    expect((onWebhook.mock.calls[0]![0] as WebhookInfo).routingKey).toBe(`github:${APP_ID}`);
  });

  // fails-when: a headerless (classic repository hook) delivery falls through to resolution.
  // breaks-if-wrong: the per-source route still accepts headerless deliveries (test above).
  it('answers 400 without App target headers and names the per-source URL', async () => {
    const { deps, onWebhook } = makeDeps();
    const res = await postOrgScoped(createGithubWebhookRoutes(deps), {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'o-2',
        'x-github-event': 'push',
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toContain(
      `/webhook/${ORG_ID}/github/<source-id>`,
    );
    expect(onWebhook).not.toHaveBeenCalled();
  });

  it('answers 400 for a non-integration target type', async () => {
    const { deps } = makeDeps();
    const res = await postOrgScoped(createGithubWebhookRoutes(deps), {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        ...appHeaders('o-3'),
        'x-github-hook-installation-target-type': 'repository',
      },
    });
    expect(res.status).toBe(400);
  });

  // fails-when: the route accepts an App that has no local sources row, or the
  //   route is missing (the framework's plain-text 404 is not this JSON body).
  it('answers 404 for an App with no local source', async () => {
    const { deps, onWebhook } = makeDeps();
    const res = await postOrgScoped(createGithubWebhookRoutes(deps), {
      body,
      headers: { 'x-hub-signature-256': sign(body), ...appHeaders('o-4', '777') },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ rejected: true, reason: 'Unknown source' });
    expect(onWebhook).not.toHaveBeenCalled();
  });

  // fails-when: the org-scoped path skips signature verification.
  it('answers 401 for a delivery signed with the wrong secret', async () => {
    const { deps, onWebhook } = makeDeps();
    const wrong = 'sha256=' + createHmac('sha256', 'not-the-secret').update(body).digest('hex');
    const res = await postOrgScoped(createGithubWebhookRoutes(deps), {
      body,
      headers: { 'x-hub-signature-256': wrong, ...appHeaders('o-5') },
    });
    expect(res.status).toBe(401);
    expect(onWebhook).not.toHaveBeenCalled();
  });

  // fails-when: the org-scoped path scopes X-GitHub-Delivery differently, so the
  //   same delivery reaching both URLs runs twice.
  it('hands the raw X-GitHub-Delivery to ingest on both routes', async () => {
    const claimed = new Set<string>();
    const onWebhook = vi.fn(async (info: WebhookInfo) => {
      if (claimed.has(info.deliveryId)) return WebhookIngestOutcome.enum.duplicate;
      claimed.add(info.deliveryId);
      return WebhookIngestOutcome.enum.processed;
    });
    const { deps } = makeDeps({ onWebhook });
    const app = createGithubWebhookRoutes(deps);
    const first = await post(app, {
      body,
      headers: { 'x-hub-signature-256': sign(body), ...appHeaders('same-1') },
    });
    const second = await postOrgScoped(app, {
      body,
      headers: { 'x-hub-signature-256': sign(body), ...appHeaders('same-1') },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(onWebhook.mock.calls.map((c) => (c[0] as WebhookInfo).deliveryId)).toEqual([
      'same-1',
      'same-1',
    ]);
  });
});
