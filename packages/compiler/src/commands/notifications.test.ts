import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as clientModule from '../remote/notifications-client.js';
import {
  notificationsChannelsListCommand,
  notificationsChannelsAddCommand,
  notificationsSubscriptionsListCommand,
  notificationsSubscriptionsAddCommand,
  notificationsRosterAddCommand,
  notificationsChannelsRemoveCommand,
} from './notifications.js';

/** Install a fake NotificationsClient with the given method stubs. */
function stubClient(methods: Partial<Record<string, ReturnType<typeof vi.fn>>>): void {
  vi.spyOn(clientModule.NotificationsClient, 'load').mockResolvedValue(
    methods as unknown as clientModule.NotificationsClient,
  );
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('notifications channels', () => {
  it('list --json prints the client rows as JSON', async () => {
    const rows = [{ id: 'ch-1', type: 'slack', name: 'alerts' }];
    stubClient({ listChannels: vi.fn().mockResolvedValue(rows) });
    const ok = await notificationsChannelsListCommand({ json: true });
    expect(ok).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(rows, null, 2));
  });

  it('add rejects an invalid --type before hitting the client', async () => {
    const create = vi.fn();
    stubClient({ createChannel: create });
    const ok = await notificationsChannelsAddCommand({ type: 'discord', name: 'x' });
    expect(ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('add slack requires --connection and --slack-channel', async () => {
    const create = vi.fn();
    stubClient({ createChannel: create });
    const ok = await notificationsChannelsAddCommand({ type: 'slack', name: 'x' });
    expect(ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('add slack posts the mapped body', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ch-9' });
    stubClient({ createChannel: create });
    const ok = await notificationsChannelsAddCommand({
      type: 'slack',
      name: 'alerts',
      connection: 'conn-1',
      slackChannel: 'C123',
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      type: 'slack',
      connection_id: 'conn-1',
      slack_channel_id: 'C123',
      name: 'alerts',
    });
  });

  it('remove calls deleteChannel', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    stubClient({ deleteChannel: del });
    const ok = await notificationsChannelsRemoveCommand('ch-1', {});
    expect(ok).toBe(true);
    expect(del).toHaveBeenCalledWith('ch-1');
  });
});

describe('notifications subscriptions', () => {
  it('list --json prints rows', async () => {
    const rows = [{ id: 'sub-1', level: 'run' }];
    stubClient({ listSubscriptions: vi.fn().mockResolvedValue(rows) });
    const ok = await notificationsSubscriptionsListCommand({ json: true });
    expect(ok).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(rows, null, 2));
  });

  it('add requires --channel and --on-status', async () => {
    const create = vi.fn();
    stubClient({ createSubscription: create });
    expect(await notificationsSubscriptionsAddCommand({ onStatus: 'failure' })).toBe(false);
    expect(await notificationsSubscriptionsAddCommand({ channel: 'ch-1' })).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('add maps flags to the create body (csv + scope defaults)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'sub-2' });
    stubClient({ createSubscription: create });
    const ok = await notificationsSubscriptionsAddCommand({
      channel: 'ch-1',
      onStatus: 'failure, success',
      mentions: 'U1,U2',
      accumulateFor: '30000',
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'run',
        channel_id: 'ch-1',
        scope_type: 'org',
        scope_id: null,
        on_status: ['failure', 'success'],
        mentions: ['U1', 'U2'],
        accumulate_for: 30000,
      }),
    );
  });

  it('add rejects team scope without --scope-id', async () => {
    const create = vi.fn();
    stubClient({ createSubscription: create });
    const ok = await notificationsSubscriptionsAddCommand({
      channel: 'ch-1',
      onStatus: 'failure',
      scope: 'team',
    });
    expect(ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('notifications roster', () => {
  it('add requires connection/subject/value', async () => {
    const add = vi.fn();
    stubClient({ addIdentity: add });
    const ok = await notificationsRosterAddCommand({ subjectKind: 'email' });
    expect(ok).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('add maps flags to the add body', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'r-1', slack_member_id: 'U9' });
    stubClient({ addIdentity: add });
    const ok = await notificationsRosterAddCommand({
      connection: 'conn-1',
      subjectKind: 'email',
      subject: 'a@example.com',
      inputForm: 'email',
      value: 'a@example.com',
    });
    expect(ok).toBe(true);
    expect(add).toHaveBeenCalledWith({
      connection_id: 'conn-1',
      subject_kind: 'email',
      subject_value: 'a@example.com',
      input_form: 'email',
      value: 'a@example.com',
    });
  });
});
