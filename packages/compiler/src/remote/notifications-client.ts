/**
 * Typed client for the Platform's org-scoped notification routes (channels,
 * subscriptions, the Slack-identity roster) behind `kici notifications`. It
 * composes a {@link DashboardClient} for auth, org-scoped URLs and error mapping;
 * every path is relative to `/api/v1/orgs/:orgId/`.
 */
import { z } from 'zod';
import { DashboardClient, DashboardClientError } from './dashboard-client.js';
import { loadGlobalConfig } from './config.js';

/**
 * Mirrored from the Platform's route contract: the public CLI cannot import the
 * private Platform package. The CLI-side single source of truth.
 */
export const NotificationChannelKind = z.enum(['slack', 'email']);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKind>;

export const NotificationSubLevel = z.enum(['run', 'job']);
export type NotificationSubLevel = z.infer<typeof NotificationSubLevel>;

export const NotificationScopeKind = z.enum(['org', 'team', 'user', 'actor']);
export type NotificationScopeKind = z.infer<typeof NotificationScopeKind>;

export const RosterSubjectKind = z.enum(['kici_user', 'git_login', 'email']);
export type RosterSubjectKind = z.infer<typeof RosterSubjectKind>;

export const RosterInputForm = z.enum(['id', 'username', 'email']);
export type RosterInputForm = z.infer<typeof RosterInputForm>;

export interface NotificationChannel {
  id: string;
  type: string;
  name: string;
  managed?: boolean;
  created_at?: string;
}

export interface NotificationSubscription {
  id: string;
  level: string;
  channel_id: string;
  scope_type: string;
  scope_id: string | null;
  on_status: string[];
  repo_glob: string | null;
  workflow_glob: string | null;
  job_glob: string | null;
  mentions: string[] | null;
  accumulate_for: number | null;
  enabled: boolean;
  source: string;
}

export interface SlackIdentity {
  id: string;
  connection_id: string;
  subject_kind: string;
  subject_value: string;
  slack_member_id: string;
  input_form: string;
  status: string;
}

export interface CreateSlackChannelBody {
  type: 'slack';
  connection_id: string;
  slack_channel_id: string;
  name: string;
}

export interface CreateEmailChannelBody {
  type: 'email';
  name: string;
  from_name?: string;
  reply_to?: string;
}

export type CreateChannelBody = CreateSlackChannelBody | CreateEmailChannelBody;

/** Mirrors the Platform create route schema. */
export interface CreateSubscriptionBody {
  level: NotificationSubLevel;
  channel_id: string;
  scope_type: NotificationScopeKind;
  scope_id?: string | null;
  on_status: string[];
  repo_glob?: string | null;
  workflow_glob?: string | null;
  job_glob?: string | null;
  mentions?: string[] | null;
  recipient_override?: string[] | null;
  on_failure_class?: string[] | null;
  accumulate_for?: number | null;
}

/** Mirrors the Platform add route schema. */
export interface AddIdentityBody {
  connection_id: string;
  subject_kind: RosterSubjectKind;
  subject_value: string;
  input_form: RosterInputForm;
  value: string;
}

const rowSchema = z.record(z.string(), z.unknown());
const channelsListSchema = z.object({ channels: z.array(rowSchema).default([]) });
const subscriptionsListSchema = z.object({ subscriptions: z.array(rowSchema).default([]) });
const identitiesListSchema = z.object({ identities: z.array(rowSchema).default([]) });

/** Construct via {@link NotificationsClient.load}, which reads `~/.kici/config`. */
export class NotificationsClient {
  private constructor(private readonly dashboard: DashboardClient) {}

  /**
   * `opts.org` overrides the saved `activeOrgId`. Throws a
   * {@link DashboardClientError} when the PAT, endpoint or org is missing.
   */
  static async load(opts: { org?: string } = {}): Promise<NotificationsClient> {
    const config = await loadGlobalConfig();
    const effective = opts.org ? { ...config, activeOrgId: opts.org } : config;
    return new NotificationsClient(DashboardClient.fromConfig(effective));
  }

  async listChannels(): Promise<NotificationChannel[]> {
    const { channels } = channelsListSchema.parse(
      await this.dashboard.getJson('notifications/channels'),
    );
    return channels as unknown as NotificationChannel[];
  }

  async createChannel(body: CreateChannelBody): Promise<NotificationChannel> {
    return (await this.dashboard.postJson('notifications/channels', body)) as NotificationChannel;
  }

  async deleteChannel(id: string): Promise<void> {
    await this.dashboard.deleteJson(`notifications/channels/${encodeURIComponent(id)}`);
  }

  async listSubscriptions(): Promise<NotificationSubscription[]> {
    const { subscriptions } = subscriptionsListSchema.parse(
      await this.dashboard.getJson('notifications/subscriptions'),
    );
    return subscriptions as unknown as NotificationSubscription[];
  }

  async createSubscription(body: CreateSubscriptionBody): Promise<NotificationSubscription> {
    return (await this.dashboard.postJson(
      'notifications/subscriptions',
      body,
    )) as NotificationSubscription;
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.dashboard.deleteJson(`notifications/subscriptions/${encodeURIComponent(id)}`);
  }

  async listIdentities(): Promise<SlackIdentity[]> {
    const { identities } = identitiesListSchema.parse(
      await this.dashboard.getJson('notifications/slack/identities'),
    );
    return identities as unknown as SlackIdentity[];
  }

  async addIdentity(body: AddIdentityBody): Promise<SlackIdentity> {
    return (await this.dashboard.postJson('notifications/slack/identities', body)) as SlackIdentity;
  }

  async deleteIdentity(id: string): Promise<void> {
    await this.dashboard.deleteJson(`notifications/slack/identities/${encodeURIComponent(id)}`);
  }
}

export { DashboardClientError };
