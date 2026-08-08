/**
 * Typed client for the Platform's org-scoped notification API — the routes the
 * dashboard Notifications tab uses (channels, subscriptions, and the Layer 1
 * Slack-identity roster). Authenticated with the stored PAT + active org,
 * exactly like {@link DashboardClient}, and reachable programmatically via the
 * `kici notifications …` CLI.
 *
 * It composes a {@link DashboardClient} (same auth / org-scoped-URL / error
 * mapping) rather than re-implementing the transport: every path here is
 * relative to `/api/v1/orgs/:orgId/notifications/…`.
 */
import { z } from 'zod';
import { DashboardClient, DashboardClientError } from './dashboard-client.js';
import { loadGlobalConfig } from './config.js';

/**
 * Notification protocol enums mirrored from the hosted Platform's notification
 * route contract. The public `kici` CLI cannot import the private Platform
 * package, so these values are re-declared here and reused across the client,
 * the command arg parsing, and their tests (the single source of truth on the
 * CLI side).
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

/** A notification channel row as returned by the channels list route. */
export interface NotificationChannel {
  id: string;
  type: string;
  name: string;
  managed?: boolean;
  created_at?: string;
}

/** A notification subscription row as returned by the subscriptions list route. */
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

/** A Slack-identity roster row as returned by the roster list route. */
export interface SlackIdentity {
  id: string;
  connection_id: string;
  subject_kind: string;
  subject_value: string;
  slack_member_id: string;
  input_form: string;
  status: string;
}

/** Body for creating a Slack channel. */
export interface CreateSlackChannelBody {
  type: 'slack';
  connection_id: string;
  slack_channel_id: string;
  name: string;
}

/** Body for creating an email channel. */
export interface CreateEmailChannelBody {
  type: 'email';
  name: string;
  from_name?: string;
  reply_to?: string;
}

export type CreateChannelBody = CreateSlackChannelBody | CreateEmailChannelBody;

/** Body for creating a subscription (mirrors the Platform create route schema). */
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

/** Body for adding a roster identity (mirrors the Platform add route schema). */
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

/**
 * PAT + org-scoped client for the notification routes. Construct via
 * {@link NotificationsClient.load}, which reads `~/.kici/config` and resolves
 * the target org (`--org` override or the saved active org).
 */
export class NotificationsClient {
  private constructor(private readonly dashboard: DashboardClient) {}

  /**
   * Load the authenticated client. `opts.org` overrides the saved active org
   * for this invocation; otherwise the saved `activeOrgId` is used. Throws a
   * {@link DashboardClientError} when the PAT / endpoint / org is missing.
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
