import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NotificationsClient } from './notifications-client.js';
import * as configModule from './config.js';
import type { GlobalConfig } from './config.js';

const baseConfig: GlobalConfig = {
  platformEndpoint: 'https://platform.example',
  pat: 'kici_pat_abc',
  activeOrgId: 'org-1',
};

function mockConfig(config: GlobalConfig): void {
  vi.spyOn(configModule, 'loadGlobalConfig').mockResolvedValue(config);
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('NotificationsClient.load', () => {
  it('throws not-logged-in when no PAT', async () => {
    mockConfig({ platformEndpoint: 'https://platform.example' });
    await expect(NotificationsClient.load()).rejects.toThrowError(/kici login/);
  });

  it('throws no-active-org when no org and no active org', async () => {
    mockConfig({ platformEndpoint: 'https://platform.example', pat: 'kici_pat_abc' });
    await expect(NotificationsClient.load()).rejects.toThrowError(/kici org use/);
  });

  it('listChannels calls the org-scoped notifications route with the bearer token', async () => {
    mockConfig(baseConfig);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ channels: [{ id: 'ch-1', type: 'slack', name: 'alerts' }] }));
    const client = await NotificationsClient.load();
    const rows = await client.listChannels();
    expect(rows).toEqual([{ id: 'ch-1', type: 'slack', name: 'alerts' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-1/notifications/channels',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer kici_pat_abc' }),
      }),
    );
  });

  it('honours the --org override in the URL', async () => {
    mockConfig(baseConfig);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ subscriptions: [] }));
    const client = await NotificationsClient.load({ org: 'org-other' });
    await client.listSubscriptions();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-other/notifications/subscriptions',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('createSubscription POSTs the body to the subscriptions route', async () => {
    mockConfig(baseConfig);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ id: 'sub-1' }, 201));
    const client = await NotificationsClient.load();
    await client.createSubscription({
      level: 'run',
      channel_id: 'ch-1',
      scope_type: 'org',
      on_status: ['failure'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-1/notifications/subscriptions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          level: 'run',
          channel_id: 'ch-1',
          scope_type: 'org',
          on_status: ['failure'],
        }),
      }),
    );
  });

  it('deleteChannel issues a DELETE to the channel route with an encoded id', async () => {
    mockConfig(baseConfig);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ deleted: true }));
    const client = await NotificationsClient.load();
    await client.deleteChannel('ch/1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-1/notifications/channels/ch%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('addIdentity POSTs to the slack/identities route', async () => {
    mockConfig(baseConfig);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ id: 'r-1' }, 201));
    const client = await NotificationsClient.load();
    await client.addIdentity({
      connection_id: 'conn-1',
      subject_kind: 'email',
      subject_value: 'a@example.com',
      input_form: 'email',
      value: 'a@example.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-1/notifications/slack/identities',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps a 403 to a forbidden DashboardClientError', async () => {
    mockConfig(baseConfig);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Insufficient permission' }), { status: 403 }),
    );
    const client = await NotificationsClient.load();
    await expect(client.listChannels()).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });
});
