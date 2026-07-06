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
});
