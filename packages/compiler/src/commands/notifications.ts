/**
 * kici notifications commands
 *
 * Customer self-service management of an org's notification configuration —
 * channels, subscriptions, and the Layer 1 Slack-identity roster — under the
 * logged-in user's PAT against the hosted Platform's org-scoped HTTP API. This
 * is a tenant-plane developer operation, so it lives in the public `kici` CLI
 * (like `kici org` / `kici verify-attestation`), never the DB-direct
 * `kici-platform-admin`.
 */

import pc from 'picocolors';
import { toErrorMessage } from '@kici-dev/core';
import {
  NotificationsClient,
  DashboardClientError,
  NotificationChannelKind,
  NotificationScopeKind,
  NotificationSubLevel,
  RosterInputForm,
  RosterSubjectKind,
  type CreateChannelBody,
  type CreateSubscriptionBody,
  type AddIdentityBody,
} from '../remote/notifications-client.js';

/** Options common to every notifications subcommand. */
export interface NotificationsCommonOptions {
  /** Target organization id (overrides the saved active org). */
  org?: string;
}

/** Options for the `list` leaves. */
export interface NotificationsListOptions extends NotificationsCommonOptions {
  json?: boolean;
}

/** Options for `channels add`. */
export interface ChannelsAddOptions extends NotificationsCommonOptions {
  type?: string;
  name?: string;
  connection?: string;
  slackChannel?: string;
  fromName?: string;
  replyTo?: string;
}

/** Options for `subscriptions add`. */
export interface SubscriptionsAddOptions extends NotificationsCommonOptions {
  channel?: string;
  level?: string;
  scope?: string;
  scopeId?: string;
  onStatus?: string;
  repoGlob?: string;
  workflowGlob?: string;
  jobGlob?: string;
  mentions?: string;
  recipientOverride?: string;
  onFailureClass?: string;
  accumulateFor?: string;
}

/** Options for `roster add`. */
export interface RosterAddOptions extends NotificationsCommonOptions {
  connection?: string;
  subjectKind?: string;
  subject?: string;
  inputForm?: string;
  value?: string;
}

/** Split a comma-separated flag value into a trimmed, non-empty list. */
function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Print a simple padded table. */
function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(pc.gray('None.'));
    return;
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(pc.bold(headers.map((h, i) => h.padEnd(widths[i])).join('   ')));
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join('   '));
  }
}

/**
 * Load the client and run `fn`, turning any {@link DashboardClientError} into a
 * red console message and a `false` return (the CLI exit-code convention).
 */
async function withClient(
  opts: NotificationsCommonOptions,
  fn: (client: NotificationsClient) => Promise<boolean>,
): Promise<boolean> {
  try {
    const client = await NotificationsClient.load({ org: opts.org });
    return await fn(client);
  } catch (err) {
    if (err instanceof DashboardClientError) {
      console.error(pc.red(err.message));
      return false;
    }
    console.error(pc.red(`Notifications command failed: ${toErrorMessage(err)}`));
    return false;
  }
}

/** Validate a value against a Zod enum, printing an actionable error on miss. */
function requireEnum<T extends string>(
  label: string,
  value: string | undefined,
  options: readonly T[],
): T | null {
  if (value === undefined) {
    console.error(pc.red(`--${label} is required (one of: ${options.join(', ')})`));
    return null;
  }
  if (!options.includes(value as T)) {
    console.error(pc.red(`Invalid --${label} "${value}" (one of: ${options.join(', ')})`));
    return null;
  }
  return value as T;
}

// ── channels ──────────────────────────────────────────────────────────────

export async function notificationsChannelsListCommand(
  opts: NotificationsListOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    const channels = await client.listChannels();
    if (opts.json) {
      console.log(JSON.stringify(channels, null, 2));
      return true;
    }
    printTable(
      ['ID', 'TYPE', 'NAME', 'MANAGED'],
      channels.map((c) => [c.id, c.type, c.name, c.managed ? 'yes' : 'no']),
    );
    return true;
  });
}

export async function notificationsChannelsAddCommand(opts: ChannelsAddOptions): Promise<boolean> {
  const type = requireEnum('type', opts.type, NotificationChannelKind.options);
  if (!type) return false;
  if (!opts.name) {
    console.error(pc.red('--name is required'));
    return false;
  }
  let body: CreateChannelBody;
  if (type === NotificationChannelKind.enum.slack) {
    if (!opts.connection || !opts.slackChannel) {
      console.error(pc.red('slack channels require --connection <id> and --slack-channel <id>'));
      return false;
    }
    body = {
      type: 'slack',
      connection_id: opts.connection,
      slack_channel_id: opts.slackChannel,
      name: opts.name,
    };
  } else {
    body = {
      type: 'email',
      name: opts.name,
      ...(opts.fromName ? { from_name: opts.fromName } : {}),
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    };
  }
  return withClient(opts, async (client) => {
    const channel = await client.createChannel(body);
    console.log(pc.green(`Channel created: ${channel.id}`));
    return true;
  });
}

export async function notificationsChannelsRemoveCommand(
  id: string,
  opts: NotificationsCommonOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    await client.deleteChannel(id);
    console.log(pc.green(`Channel removed: ${id}`));
    return true;
  });
}

// ── subscriptions ───────────────────────────────────────────────────────────

export async function notificationsSubscriptionsListCommand(
  opts: NotificationsListOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    const subs = await client.listSubscriptions();
    if (opts.json) {
      console.log(JSON.stringify(subs, null, 2));
      return true;
    }
    printTable(
      ['ID', 'LEVEL', 'SCOPE', 'CHANNEL', 'ON STATUS', 'ENABLED'],
      subs.map((s) => [
        s.id,
        s.level,
        s.scope_id ? `${s.scope_type}:${s.scope_id}` : s.scope_type,
        s.channel_id,
        (s.on_status ?? []).join(','),
        s.enabled ? 'yes' : 'no',
      ]),
    );
    return true;
  });
}

/** Build a create-subscription body from parsed flags (null on validation error). */
function buildSubscriptionBody(opts: SubscriptionsAddOptions): CreateSubscriptionBody | null {
  if (!opts.channel) {
    console.error(pc.red('--channel <id> is required'));
    return null;
  }
  const level = requireEnum('level', opts.level ?? 'run', NotificationSubLevel.options);
  if (!level) return null;
  const scope = requireEnum('scope', opts.scope ?? 'org', NotificationScopeKind.options);
  if (!scope) return null;
  const onStatus = parseCsv(opts.onStatus);
  if (onStatus.length === 0) {
    console.error(pc.red('--on-status <csv> is required (e.g. failed,success)'));
    return null;
  }
  const needsScopeId =
    scope === NotificationScopeKind.enum.team || scope === NotificationScopeKind.enum.user;
  if (needsScopeId && !opts.scopeId) {
    console.error(pc.red(`--scope-id is required for ${scope} scope`));
    return null;
  }
  let accumulateFor: number | null = null;
  if (opts.accumulateFor !== undefined) {
    accumulateFor = Number(opts.accumulateFor);
    if (!Number.isFinite(accumulateFor)) {
      console.error(pc.red('--accumulate-for must be a number of milliseconds'));
      return null;
    }
  }
  const mentions = parseCsv(opts.mentions);
  const recipientOverride = parseCsv(opts.recipientOverride);
  const onFailureClass = parseCsv(opts.onFailureClass);
  return {
    level,
    channel_id: opts.channel,
    scope_type: scope,
    scope_id: needsScopeId ? opts.scopeId : null,
    on_status: onStatus,
    repo_glob: opts.repoGlob ?? null,
    workflow_glob: opts.workflowGlob ?? null,
    job_glob: opts.jobGlob ?? null,
    mentions: mentions.length > 0 ? mentions : null,
    recipient_override: recipientOverride.length > 0 ? recipientOverride : null,
    on_failure_class: onFailureClass.length > 0 ? onFailureClass : null,
    accumulate_for: accumulateFor,
  };
}

export async function notificationsSubscriptionsAddCommand(
  opts: SubscriptionsAddOptions,
): Promise<boolean> {
  const body = buildSubscriptionBody(opts);
  if (!body) return false;
  return withClient(opts, async (client) => {
    const sub = await client.createSubscription(body);
    console.log(pc.green(`Subscription created: ${sub.id}`));
    return true;
  });
}

export async function notificationsSubscriptionsRemoveCommand(
  id: string,
  opts: NotificationsCommonOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    await client.deleteSubscription(id);
    console.log(pc.green(`Subscription removed: ${id}`));
    return true;
  });
}

// ── roster ────────────────────────────────────────────────────────────────

export async function notificationsRosterListCommand(
  opts: NotificationsListOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    const identities = await client.listIdentities();
    if (opts.json) {
      console.log(JSON.stringify(identities, null, 2));
      return true;
    }
    printTable(
      ['ID', 'SUBJECT KIND', 'SUBJECT', 'SLACK MEMBER', 'STATUS'],
      identities.map((r) => [r.id, r.subject_kind, r.subject_value, r.slack_member_id, r.status]),
    );
    return true;
  });
}

/** Build an add-identity body from parsed flags (null on validation error). */
function buildIdentityBody(opts: RosterAddOptions): AddIdentityBody | null {
  if (!opts.connection) {
    console.error(pc.red('--connection <id> is required'));
    return null;
  }
  const subjectKind = requireEnum('subject-kind', opts.subjectKind, RosterSubjectKind.options);
  if (!subjectKind) return null;
  if (!opts.subject) {
    console.error(pc.red('--subject <value> is required (the KiCI user sub, git login, or email)'));
    return null;
  }
  const inputForm = requireEnum('input-form', opts.inputForm ?? 'id', RosterInputForm.options);
  if (!inputForm) return null;
  if (!opts.value) {
    console.error(pc.red('--value <slack id | email | @handle> is required'));
    return null;
  }
  return {
    connection_id: opts.connection,
    subject_kind: subjectKind,
    subject_value: opts.subject,
    input_form: inputForm,
    value: opts.value,
  };
}

export async function notificationsRosterAddCommand(opts: RosterAddOptions): Promise<boolean> {
  const body = buildIdentityBody(opts);
  if (!body) return false;
  return withClient(opts, async (client) => {
    const row = await client.addIdentity(body);
    console.log(pc.green(`Roster identity added: ${row.id} → ${row.slack_member_id}`));
    return true;
  });
}

export async function notificationsRosterRemoveCommand(
  id: string,
  opts: NotificationsCommonOptions,
): Promise<boolean> {
  return withClient(opts, async (client) => {
    await client.deleteIdentity(id);
    console.log(pc.green(`Roster identity removed: ${id}`));
    return true;
  });
}
