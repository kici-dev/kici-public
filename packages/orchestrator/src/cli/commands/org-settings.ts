/**
 * Org-settings management commands for kici-admin.
 *
 * Subcommand namespace: `kici-admin org-settings global-workflows <subcommand>`
 * and `kici-admin org-settings dashboard-writes <subcommand>`.
 *
 * Talks to the orchestrator admin API directly (not the Platform dashboard
 * proxy), so the CLI stays operable even when Platform is unavailable. Backed
 * by `packages/orchestrator/src/routes/admin-org-settings.ts`.
 *
 * The settings row is org-scoped (one row per `customer_id`). Each pattern
 * entry can optionally pin a webhook source via `--source <routingKey>`.
 * Omitting `--source` stores the entry as "any source in the org".
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import {
  DASHBOARD_WRITE_OPERATIONS,
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
  DashboardWriteCategory,
  DashboardWriteOperation,
  DashboardWritePolicyState,
  DashboardWriteSensitivity,
  type DashboardWritePolicyMap,
} from '@kici-dev/engine/protocol/dashboard-write-operations';

interface RepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

interface GlobalWorkflowSettings {
  customerId: string;
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  elevatedRepos: RepoPatternEntry[] | null;
  allowHttpNpmRegistries: boolean;
  userCacheQuotaBytes: number | null;
  userCacheTtlMs: number | null;
  artifactQuotaBytes: number | null;
  artifactTtlMs: number | null;
  artifactMaxBytes: number | null;
  artifactMaxPerRun: number | null;
  dispatchAckTimeoutMs: number | null;
  ingestMaxConcurrency: number | null;
  scalerSpawnTimeoutMs: number | null;
  rerouteSpawnWindowMs: number | null;
  rerouteAckTimeoutMs: number | null;
  rerouteMaxHops: number | null;
  backupStalenessWarnHours: number | null;
  queueTimeoutMs: number | null;
  approvalExpirySeconds: number;
  allowSelfApproval: boolean;
  // Optional: an older orchestrator's /org-settings response predates the
  // sandbox escape-hatch allow-list, so a newer CLI must tolerate their absence.
  sandboxAllowedCapabilities?: string[];
  sandboxAllowHostNetwork?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface SettingsResponse {
  settings: GlobalWorkflowSettings;
}

interface PatchBody {
  customerId: string;
  allowedRepos?: RepoPatternEntry[] | null;
  deniedRepos?: RepoPatternEntry[] | null;
  elevatedRepos?: RepoPatternEntry[] | null;
  allowHttpNpmRegistries?: boolean;
  userCacheQuotaBytes?: number | null;
  userCacheTtlMs?: number | null;
  artifactQuotaBytes?: number | null;
  artifactTtlMs?: number | null;
  artifactMaxBytes?: number | null;
  artifactMaxPerRun?: number | null;
  dispatchAckTimeoutMs?: number | null;
  ingestMaxConcurrency?: number | null;
  scalerSpawnTimeoutMs?: number | null;
  rerouteSpawnWindowMs?: number | null;
  rerouteAckTimeoutMs?: number | null;
  rerouteMaxHops?: number | null;
  backupStalenessWarnHours?: number | null;
  queueTimeoutMs?: number | null;
  approvalExpirySeconds?: number;
  allowSelfApproval?: boolean;
  sandboxAllowedCapabilities?: string[] | null;
  sandboxAllowHostNetwork?: boolean | null;
}

type ListField = 'allowedRepos' | 'deniedRepos' | 'elevatedRepos';
type Prefix = 'allow' | 'deny' | 'elevate';

function formatSettings(s: GlobalWorkflowSettings, format: string): string {
  if (format === 'json') return JSON.stringify(s, null, 2);
  const lines: string[] = [];
  lines.push(`Customer/org id:       ${s.customerId}`);
  lines.push(`Enabled (cluster-wide): ${s.enabled}`);
  lines.push(
    `Allowed authors:       ${s.allowedRepos === null ? '(any repo)' : formatList(s.allowedRepos)}`,
  );
  lines.push(
    `Denied source repos:   ${s.deniedRepos === null ? '(none)' : formatList(s.deniedRepos)}`,
  );
  lines.push(
    `Elevated authors:      ${s.elevatedRepos === null ? '(none)' : formatList(s.elevatedRepos)}`,
  );
  lines.push(`Allow http registries: ${s.allowHttpNpmRegistries}`);
  lines.push(
    `User-cache quota:      ${s.userCacheQuotaBytes === null ? '(cluster default)' : `${s.userCacheQuotaBytes} bytes`}`,
  );
  lines.push(
    `User-cache TTL:        ${s.userCacheTtlMs === null ? '(cluster default)' : `${s.userCacheTtlMs} ms`}`,
  );
  lines.push(
    `Artifact quota:        ${s.artifactQuotaBytes === null ? '(cluster default)' : `${s.artifactQuotaBytes} bytes`}`,
  );
  lines.push(
    `Artifact TTL:          ${s.artifactTtlMs === null ? '(cluster default)' : `${s.artifactTtlMs} ms`}`,
  );
  lines.push(
    `Artifact max bytes:    ${s.artifactMaxBytes === null ? '(cluster default)' : `${s.artifactMaxBytes} bytes`}`,
  );
  lines.push(
    `Artifact max/run:      ${s.artifactMaxPerRun === null ? '(cluster default)' : `${s.artifactMaxPerRun}`}`,
  );
  lines.push(
    `Dispatch ack timeout:  ${s.dispatchAckTimeoutMs === null ? '(cluster default)' : `${s.dispatchAckTimeoutMs} ms`}`,
  );
  lines.push(
    `Ingest max concurrency:${s.ingestMaxConcurrency === null ? ' (cluster default)' : ` ${s.ingestMaxConcurrency}`}`,
  );
  lines.push(
    `Scaler spawn timeout:  ${s.scalerSpawnTimeoutMs === null ? '(cluster default)' : `${s.scalerSpawnTimeoutMs} ms`}`,
  );
  lines.push(
    `Reroute spawn window:  ${s.rerouteSpawnWindowMs === null ? '(cluster default)' : `${s.rerouteSpawnWindowMs} ms`}`,
  );
  lines.push(
    `Reroute ack timeout:   ${s.rerouteAckTimeoutMs === null ? '(cluster default)' : `${s.rerouteAckTimeoutMs} ms`}`,
  );
  lines.push(
    `Reroute max hops:      ${s.rerouteMaxHops === null ? '(cluster default)' : `${s.rerouteMaxHops}`}`,
  );
  lines.push(
    `Backup staleness warn: ${s.backupStalenessWarnHours === null ? '(cluster default)' : `${s.backupStalenessWarnHours} h`}`,
  );
  lines.push(
    `Queue timeout:         ${s.queueTimeoutMs === null ? '(cluster default)' : `${s.queueTimeoutMs} ms`}`,
  );
  lines.push(`Approval expiry:       ${s.approvalExpirySeconds} s`);
  lines.push(`Allow self-approval:   ${s.allowSelfApproval}`);
  // Tolerate an older orchestrator whose /org-settings response predates these
  // fields (a newer CLI must not crash against an older orchestrator).
  const sandboxCaps = s.sandboxAllowedCapabilities ?? [];
  lines.push(
    `Sandbox capabilities:  ${sandboxCaps.length === 0 ? '(none — deny all)' : sandboxCaps.join(', ')}`,
  );
  lines.push(`Sandbox host network:  ${s.sandboxAllowHostNetwork ?? false}`);
  if (s.createdAt) lines.push(`Created at:            ${s.createdAt}`);
  if (s.updatedAt) lines.push(`Updated at:            ${s.updatedAt}`);
  return lines.join('\n');
}

function formatList(items: RepoPatternEntry[]): string {
  if (items.length === 0) return '(empty)';
  return items.map(formatEntry).join(', ');
}

function formatEntry(entry: RepoPatternEntry): string {
  if (entry.routingKey) return `${entry.routingKey}:${entry.pattern}`;
  return `*:${entry.pattern}`;
}

function entriesEqual(a: RepoPatternEntry, b: RepoPatternEntry): boolean {
  return (a.routingKey ?? '') === (b.routingKey ?? '') && a.pattern === b.pattern;
}

async function fetchSettings(
  client: AdminApiClient,
  customerId: string,
): Promise<GlobalWorkflowSettings> {
  const res = await client.get<SettingsResponse>(
    `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(customerId)}`,
  );
  return res.settings;
}

async function patchSettings(
  client: AdminApiClient,
  body: PatchBody,
): Promise<GlobalWorkflowSettings> {
  const res = await client.patch<SettingsResponse>(
    `/api/v1/admin/org-settings/global-workflows`,
    body,
  );
  return res.settings;
}

export function registerOrgSettingsCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const orgSettings = program
    .command('org-settings')
    .description('Manage org-level security settings');

  const gw = orgSettings
    .command('global-workflows')
    .description('Manage per-org global workflow policy');

  // ── show ─────────────────────────────────────────────────────────
  gw.command('show')
    .description('Print current global workflow settings for an org')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── list mutators ────────────────────────────────────────────────
  registerListMutators(gw, getClient, 'allow', 'allowedRepos');
  registerListMutators(gw, getClient, 'deny', 'deniedRepos');
  registerListMutators(gw, getClient, 'elevate', 'elevatedRepos');

  // ── dashboard-writes ─────────────────────────────────────────────
  registerDashboardWritesCommands(orgSettings, getClient);

  // ── allow-http-npm ───────────────────────────────────────────────
  // Lives under `org-settings` (not under `global-workflows`) because
  // it gates the install-time npm-registry behaviour, not the global
  // workflow allow/deny lists.
  orgSettings
    .command('allow-http-npm <value>')
    .description(
      'Permit plain http:// npm registry URLs in workflow registries:. ' +
        'Default false; loopback / *.local are always allowed regardless.',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const allow = value === 'true' ? true : value === 'false' ? false : undefined;
      if (allow === undefined) {
        console.error('Error: value must be "true" or "false"');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await patchSettings(getClient(), {
          customerId,
          allowHttpNpmRegistries: allow,
        });
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── user-cache ───────────────────────────────────────────────────
  registerUserCacheCommands(orgSettings, getClient);
  registerArtifactCommands(orgSettings, getClient);

  // ── dispatch-ack ─────────────────────────────────────────────────
  registerDispatchAckCommands(orgSettings, getClient);

  registerScalerSpawnTimeoutCommands(orgSettings, getClient);

  // ── ingest-concurrency ───────────────────────────────────────────
  registerIngestConcurrencyCommands(orgSettings, getClient);

  // ── sandbox-allowlist ────────────────────────────────────────────
  registerSandboxAllowlistCommands(orgSettings, getClient);

  // ── reroute ──────────────────────────────────────────────────────
  registerRerouteCommands(orgSettings, getClient);

  // ── backup-freshness ─────────────────────────────────────────────
  registerBackupFreshnessCommands(orgSettings, getClient);

  // ── queue-timeout ────────────────────────────────────────────────
  registerQueueTimeoutCommands(orgSettings, getClient);

  // ── approval ─────────────────────────────────────────────────────
  registerApprovalCommands(orgSettings, getClient);
}

/**
 * `kici-admin org-settings backup-freshness <show|set|reset>`.
 *
 * The per-org DB-backup freshness WARN threshold (hours). Null (unset) means
 * the cluster-wide config default (`config.backupStalenessWarnHours`) applies.
 */
function registerBackupFreshnessCommands(
  orgSettings: Command,
  getClient: () => AdminApiClient,
): void {
  const bf = orgSettings
    .command('backup-freshness')
    .description('Manage the per-org DB-backup freshness WARN threshold (null = cluster default)');

  bf.command('show')
    .description('Print the current per-org backup-freshness threshold')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        console.log(formatSettings(await fetchSettings(getClient(), customerId), opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  bf.command('set')
    .description('Set the per-org backup-freshness WARN threshold in hours (>= 1)')
    .requiredOption('--hours <n>', 'Threshold in hours (integer >= 1)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { hours: string; customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      const hours = parseIntFlag(opts.hours, 1, 'hours');
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          backupStalenessWarnHours: hours,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  bf.command('reset')
    .description('Clear the per-org override (fall back to the cluster default)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          backupStalenessWarnHours: null,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings reroute <show|set|reset>`.
 *
 * The per-org cross-peer reroute tunables: the post-ACK spawn window
 * (`reroute_spawn_window_ms`), the reroute ACK timeout
 * (`reroute_ack_timeout_ms`), and the max peer hops (`reroute_max_hops`). A
 * null (unset) value means the cluster-wide config default applies. `set`
 * flips one or more; `reset` clears all three overrides at once.
 */
function registerRerouteCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const rr = orgSettings
    .command('reroute')
    .description('Manage the per-org cross-peer reroute tunables (null = cluster default)');

  rr.command('show')
    .description('Print the current per-org reroute tunables')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  rr.command('set')
    .description(
      'Set one or more reroute tunables. At least one of --window / --ack-timeout / --max-hops.',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--window <ms>', 'Spawn window (integer milliseconds, >= 1000)')
    .option('--ack-timeout <ms>', 'Reroute ACK timeout (integer milliseconds, >= 1000)')
    .option('--max-hops <n>', 'Maximum peer hops (integer >= 1)')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (opts: {
        customerId?: string;
        org?: string;
        window?: string;
        ackTimeout?: string;
        maxHops?: string;
        format: string;
      }) => {
        const customerId = resolveCustomerId(opts);
        const patch = buildReroutePatch(customerId, opts);
        try {
          const updated = await patchSettings(getClient(), patch);
          console.log(formatSettings(updated, opts.format));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  rr.command('reset')
    .description('Clear all per-org reroute overrides (fall back to the cluster defaults)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          rerouteSpawnWindowMs: null,
          rerouteAckTimeoutMs: null,
          rerouteMaxHops: null,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/** Validate `reroute set` flags and assemble the PATCH body (exits on bad input). */
function buildReroutePatch(
  customerId: string,
  opts: { window?: string; ackTimeout?: string; maxHops?: string },
): PatchBody {
  const patch: PatchBody = { customerId };
  if (opts.window !== undefined) {
    patch.rerouteSpawnWindowMs = parseIntFlag(opts.window, 1000, 'window (milliseconds)');
  }
  if (opts.ackTimeout !== undefined) {
    patch.rerouteAckTimeoutMs = parseIntFlag(opts.ackTimeout, 1000, 'ack-timeout (milliseconds)');
  }
  if (opts.maxHops !== undefined) {
    patch.rerouteMaxHops = parseIntFlag(opts.maxHops, 1, 'max-hops');
  }
  if (
    patch.rerouteSpawnWindowMs === undefined &&
    patch.rerouteAckTimeoutMs === undefined &&
    patch.rerouteMaxHops === undefined
  ) {
    console.error('Error: pass at least one of --window / --ack-timeout / --max-hops');
    process.exit(1);
  }
  return patch;
}

/**
 * `kici-admin org-settings queue-timeout <show|set|reset>`.
 *
 * The per-org dispatch-queue job timeout (`org_settings.queue_timeout_ms`): a
 * queued job's deadline is `job.timeoutMs ?? <this> ?? config.queueTimeoutMs`.
 * null clears the override → cluster default. `set 0` = indefinite (no expiry).
 */
function registerQueueTimeoutCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const qt = orgSettings
    .command('queue-timeout')
    .description('Manage the per-org dispatch-queue job timeout (null = cluster default)');

  qt.command('show')
    .description('Print the current per-org queue timeout')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  qt.command('set')
    .description('Set the per-org queue timeout in milliseconds (0 = indefinite)')
    .argument('<ms>', 'Queue timeout in milliseconds (integer >= 0)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (ms: string, opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      const queueTimeoutMs = parseIntFlag(ms, 0, 'ms (milliseconds)');
      try {
        const updated = await patchSettings(getClient(), { customerId, queueTimeoutMs });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  qt.command('reset')
    .description('Clear the per-org queue-timeout override (fall back to the cluster default)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), { customerId, queueTimeoutMs: null });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/** Parse an integer CLI flag with a minimum, exiting with an error on failure. */
function parseIntFlag(value: string, min: number, fieldLabel: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    console.error(`Error: --${fieldLabel.split(' ')[0]} must be an integer >= ${min}`);
    process.exit(1);
  }
  return n;
}

/**
 * `kici-admin org-settings approval <show|set-expiry|set-self-approval>`.
 *
 * The per-org held-approval policy: how long a held element waits before it
 * expires (`approval_expiry_seconds`, default 86400) and whether a run's
 * triggerer may approve its own held elements (`allow_self_approval`, default
 * true). Both have NOT NULL DB defaults, so there is no "reset to cluster
 * default" — set replaces the current value.
 */
function registerApprovalCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const ap = orgSettings
    .command('approval')
    .description('Manage the per-org held-approval expiry + self-approval policy');

  ap.command('show')
    .description('Print the current per-org approval policy')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ap.command('set-expiry <seconds>')
    .description('Set the per-org held-approval expiry (integer seconds, >= 1)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        console.error('Error: value must be an integer >= 1 (seconds)');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          approvalExpirySeconds: n,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ap.command('set-self-approval <value>')
    .description('Allow or forbid a run triggerer approving its own held elements (true|false)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      if (value !== 'true' && value !== 'false') {
        console.error('Error: value must be "true" or "false"');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          allowSelfApproval: value === 'true',
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings dispatch-ack <show|set|reset>`.
 *
 * The per-org dispatch-acknowledgment deadline (ms). A null (unset) value
 * means the cluster-wide default applies (`KICI_DISPATCH_ACK_TIMEOUT_MS`,
 * default 10s). Operators raise it on high-latency networks.
 */
function registerDispatchAckCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const da = orgSettings
    .command('dispatch-ack')
    .description('Manage the per-org dispatch-acknowledgment deadline (null = cluster default)');

  da.command('show')
    .description('Print the current per-org dispatch-acknowledgment deadline')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  da.command('set <value>')
    .description('Set the per-org dispatch-acknowledgment deadline (integer milliseconds, >= 1000)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1000) {
        console.error('Error: value must be an integer >= 1000 (milliseconds)');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          dispatchAckTimeoutMs: n,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  da.command('reset')
    .description(
      'Clear the per-org dispatch-ack deadline override (fall back to the cluster default)',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          dispatchAckTimeoutMs: null,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings scaler-spawn-timeout <show|set|reset>`.
 *
 * The per-org deadline (ms) for a single scaler `backend.spawn` (image pull +
 * container create + start). A hung runtime/registry that blows this deadline
 * is aborted so it can no longer pin its per-backend spawn-semaphore slot and
 * head-of-line block every queued spawn. A null (unset) value means the
 * cluster-wide default applies (`KICI_SCALER_SPAWN_TIMEOUT_MS`, default 300s).
 */
function registerScalerSpawnTimeoutCommands(
  orgSettings: Command,
  getClient: () => AdminApiClient,
): void {
  const ss = orgSettings
    .command('scaler-spawn-timeout')
    .description('Manage the per-org scaler spawn deadline (null = cluster default)');

  ss.command('show')
    .description('Print the current per-org scaler spawn deadline')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ss.command('set <value>')
    .description('Set the per-org scaler spawn deadline (integer milliseconds, >= 1000)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1000) {
        console.error('Error: value must be an integer >= 1000 (milliseconds)');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          scalerSpawnTimeoutMs: n,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ss.command('reset')
    .description(
      'Clear the per-org scaler spawn deadline override (fall back to the cluster default)',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          scalerSpawnTimeoutMs: null,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings ingest-concurrency <show|set|reset>`.
 *
 * The per-org webhook-ingest concurrency cap — the maximum number of
 * concurrent `processWebhook` pipelines the admission controller admits for
 * this org before shedding with `429 + Retry-After`. A null (unset) value
 * means the cluster-wide default applies (`KICI_INGEST_ORG_MAX_CONCURRENCY`,
 * default 32). Operators lower it to rein in a noisy tenant or raise it for a
 * high-fan-in org.
 */
function registerIngestConcurrencyCommands(
  orgSettings: Command,
  getClient: () => AdminApiClient,
): void {
  const ic = orgSettings
    .command('ingest-concurrency')
    .description('Manage the per-org webhook-ingest concurrency cap (null = cluster default)');

  ic.command('show')
    .description('Print the current per-org webhook-ingest concurrency cap')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ic.command('set <value>')
    .description('Set the per-org webhook-ingest concurrency cap (integer, >= 1)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        console.error('Error: value must be an integer >= 1');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          ingestMaxConcurrency: n,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  ic.command('reset')
    .description(
      'Clear the per-org webhook-ingest concurrency override (fall back to the cluster default)',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          ingestMaxConcurrency: null,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings sandbox-allowlist <show|set-capabilities|allow-host-network|reset>`.
 *
 * The per-org container-sandbox escape-hatch allow-list. `set-capabilities`
 * replaces the allowed Linux capability list a workflow may request via the SDK
 * `sandbox: { capabilities }` field (comma-separated; empty = clear → deny all).
 * `allow-host-network` toggles whether a workflow may request
 * `sandbox: { network: 'host' }`. Empty / false is the safe deny-all default; a
 * non-allow-listed request FAILS the run at dispatch.
 */
function registerSandboxAllowlistCommands(
  orgSettings: Command,
  getClient: () => AdminApiClient,
): void {
  const sa = orgSettings
    .command('sandbox-allowlist')
    .description('Manage the per-org container-sandbox escape-hatch allow-list (empty = deny all)');

  sa.command('show')
    .description('Print the current per-org sandbox capability + host-network allow-list')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  sa.command('set-capabilities <capabilities>')
    .description(
      'Set the allowed capabilities (comma-separated, e.g. NET_ADMIN,SYS_PTRACE; empty clears)',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (capabilities: string, opts: { customerId?: string; org?: string; format: string }) => {
        const list = capabilities
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        const customerId = resolveCustomerId(opts);
        try {
          const updated = await patchSettings(getClient(), {
            customerId,
            sandboxAllowedCapabilities: list,
          });
          console.log(formatSettings(updated, opts.format));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  sa.command('allow-host-network <value>')
    .description('Allow (true) or deny (false) workflow-requested host networking')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      if (value !== 'true' && value !== 'false') {
        console.error('Error: value must be "true" or "false"');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          sandboxAllowHostNetwork: value === 'true',
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  sa.command('reset')
    .description('Clear the allow-list (deny all capabilities and host networking)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          sandboxAllowedCapabilities: null,
          sandboxAllowHostNetwork: false,
        });
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * `kici-admin org-settings user-cache <show|set-quota|set-ttl|reset-quota|reset-ttl>`.
 *
 * The per-org byte quota and per-entry TTL for the user-facing cache. A null
 * (unset) value means the cluster-wide default applies (the
 * `KICI_USER_CACHE_QUOTA_BYTES` / `KICI_USER_CACHE_TTL_MS` env vars).
 */
function registerUserCacheCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const uc = orgSettings
    .command('user-cache')
    .description('Manage per-org user-facing cache quota + entry TTL (null = cluster default)');

  uc.command('show')
    .description('Print the current per-org user-cache quota + TTL settings')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  registerUserCacheSetter(uc, getClient, 'quota');
  registerUserCacheSetter(uc, getClient, 'ttl');
}

/**
 * `kici-admin org-settings artifacts
 *   <show|set-quota|set-ttl|set-max-bytes|set-max-per-run|reset-*>`.
 *
 * The per-org byte quota, per-artifact TTL, per-artifact size cap, and per-run
 * artifact count cap for user-facing artifacts. A null (unset) value means the
 * cluster-wide default applies (the `KICI_ARTIFACT_QUOTA_BYTES` /
 * `KICI_ARTIFACT_TTL_MS` / `KICI_ARTIFACT_MAX_BYTES` /
 * `KICI_ARTIFACT_MAX_PER_RUN` env vars).
 */
function registerArtifactCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const art = orgSettings
    .command('artifacts')
    .description(
      'Manage per-org artifact quota / TTL / size cap / per-run cap (null = cluster default)',
    );

  art
    .command('show')
    .description('Print the current per-org artifact quota + TTL settings')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await fetchSettings(getClient(), customerId);
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  registerArtifactSetter(art, getClient, 'quota');
  registerArtifactSetter(art, getClient, 'ttl');
  registerArtifactSetter(art, getClient, 'max-bytes');
  registerArtifactSetter(art, getClient, 'max-per-run');
}

/**
 * Register `set-<knob>` / `reset-<knob>` for a per-org artifact knob: the byte
 * quota, ms TTL, per-artifact size cap (`max-bytes`), or per-run count cap
 * (`max-per-run`). A null (reset) value falls back to the cluster default.
 */
function registerArtifactSetter(
  art: Command,
  getClient: () => AdminApiClient,
  knob: 'quota' | 'ttl' | 'max-bytes' | 'max-per-run',
): void {
  const field = (
    {
      quota: 'artifactQuotaBytes',
      ttl: 'artifactTtlMs',
      'max-bytes': 'artifactMaxBytes',
      'max-per-run': 'artifactMaxPerRun',
    } as const
  )[knob];
  const unit = (
    {
      quota: 'bytes',
      ttl: 'milliseconds',
      'max-bytes': 'bytes',
      'max-per-run': 'artifacts',
    } as const
  )[knob];

  art
    .command(`set-${knob} <value>`)
    .description(`Set the per-org artifact ${knob} (positive integer ${unit})`)
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`Error: value must be a positive integer (${unit})`);
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          [field]: n,
        } as PatchBody);
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  art
    .command(`reset-${knob}`)
    .description(`Clear the per-org artifact ${knob} override (fall back to the cluster default)`)
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          [field]: null,
        } as PatchBody);
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/** Register `set-<knob>` and `reset-<knob>` for the byte-quota / ms-TTL knobs. */
function registerUserCacheSetter(
  uc: Command,
  getClient: () => AdminApiClient,
  knob: 'quota' | 'ttl',
): void {
  const field = knob === 'quota' ? 'userCacheQuotaBytes' : 'userCacheTtlMs';
  const unit = knob === 'quota' ? 'bytes' : 'milliseconds';

  uc.command(`set-${knob} <value>`)
    .description(`Set the per-org user-cache ${knob} (positive integer ${unit})`)
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`Error: value must be a positive integer (${unit})`);
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          [field]: n,
        } as PatchBody);
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  uc.command(`reset-${knob}`)
    .description(`Clear the per-org user-cache ${knob} override (fall back to the cluster default)`)
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const updated = await patchSettings(getClient(), {
          customerId,
          [field]: null,
        } as PatchBody);
        console.log(formatSettings(updated, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/** Register `<prefix>-add` and `<prefix>-remove` commands bound to a list field. */
function registerListMutators(
  gw: Command,
  getClient: () => AdminApiClient,
  prefix: Prefix,
  field: ListField,
): void {
  gw.command(`${prefix}-add <pattern>`)
    .description(
      `Add a glob pattern to the ${label(prefix)}. Use --source to qualify the entry to one webhook source.`,
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option(
      '--source <routingKey>',
      'Pin the entry to one webhook source (e.g. github:42). Omit for any source.',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (
        pattern: string,
        opts: { customerId?: string; org?: string; source?: string; format: string },
      ) => {
        const customerId = resolveCustomerId(opts);
        try {
          const current = await fetchSettings(getClient(), customerId);
          const existing = (current[field] ?? []) as RepoPatternEntry[];
          const newEntry: RepoPatternEntry = opts.source
            ? { routingKey: opts.source, pattern }
            : { pattern };
          if (existing.some((entry) => entriesEqual(entry, newEntry))) {
            console.log(`Entry ${formatEntry(newEntry)} already present; no change.`);
            console.log(formatSettings(current, opts.format));
            return;
          }
          const next = [...existing, newEntry];
          const updated = await patchSettings(getClient(), {
            customerId,
            [field]: next,
          } as PatchBody);
          console.log(formatSettings(updated, opts.format));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  gw.command(`${prefix}-remove <pattern>`)
    .description(
      `Remove a glob pattern from the ${label(prefix)}. Use --source to target a source-qualified entry.`,
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option(
      '--source <routingKey>',
      'Match an entry pinned to this routing key. Omit to match an unqualified entry.',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (
        pattern: string,
        opts: { customerId?: string; org?: string; source?: string; format: string },
      ) => {
        const customerId = resolveCustomerId(opts);
        try {
          const current = await fetchSettings(getClient(), customerId);
          const existing = (current[field] ?? []) as RepoPatternEntry[];
          const target: RepoPatternEntry = opts.source
            ? { routingKey: opts.source, pattern }
            : { pattern };
          if (!existing.some((entry) => entriesEqual(entry, target))) {
            console.log(`Entry ${formatEntry(target)} not found; no change.`);
            console.log(formatSettings(current, opts.format));
            return;
          }
          const next = existing.filter((entry) => !entriesEqual(entry, target));
          const updated = await patchSettings(getClient(), {
            customerId,
            [field]: next,
          } as PatchBody);
          console.log(formatSettings(updated, opts.format));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}

function resolveCustomerId(opts: { customerId?: string; org?: string }): string {
  const id = opts.customerId ?? opts.org;
  if (!id) {
    console.error('Error: --customer-id (or --org) is required');
    process.exit(1);
  }
  return id;
}

function label(prefix: Prefix): string {
  if (prefix === 'allow') return 'workflow-author allow-list';
  if (prefix === 'deny') return 'source-repo deny-list';
  // The elevated-access list is stored but never consulted — an
  // organization-wide workflow's job is dispatched with no secret material, so
  // there is nothing for the list to widen. Say so in the command's own help
  // text rather than only in the docs, since the CLI is where an operator most
  // plausibly reaches for it.
  return 'elevated-access list (DEPRECATED: not enforced, removed at v1.0.0)';
}

// ─── dashboard-writes ───────────────────────────────────────────────

interface DashboardWritesResponse {
  customerId: string;
  stored: DashboardWritePolicyMap;
  effective: Record<DashboardWriteOperation, boolean>;
  /** Tri-state posture per operation (permissive | encrypted | disabled). */
  states?: Record<DashboardWriteOperation, DashboardWritePolicyState>;
}

/** Legacy boolean sugar for --op / --enabled: true→permissive, false→disabled. */
function parseStateToken(token: string): DashboardWritePolicyState | null {
  const t = token.toLowerCase();
  if (t === 'true') return 'permissive';
  if (t === 'false') return 'disabled';
  const parsed = DashboardWritePolicyState.safeParse(t);
  return parsed.success ? parsed.data : null;
}

function formatDashboardWrites(
  response: DashboardWritesResponse,
  format: string,
  filter?: { category?: DashboardWriteCategory; sensitivity?: DashboardWriteSensitivity },
): string {
  if (format === 'json') return JSON.stringify(response, null, 2);
  const lines: string[] = [];
  lines.push(`Customer/org id: ${response.customerId}`);
  lines.push('');
  type DescriptorElement = (typeof DASHBOARD_WRITE_OPERATIONS)[number];
  const byCategory = new Map<DashboardWriteCategory, DescriptorElement[]>();
  for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
    if (filter?.category && descriptor.category !== filter.category) continue;
    if (filter?.sensitivity && descriptor.sensitivity !== filter.sensitivity) continue;
    const list = byCategory.get(descriptor.category) ?? [];
    list.push(descriptor);
    byCategory.set(descriptor.category, list);
  }
  for (const [category, descriptors] of byCategory) {
    lines.push(`${category.toUpperCase()}`);
    for (const descriptor of descriptors) {
      const state =
        response.states?.[descriptor.name] ??
        ((response.effective[descriptor.name] ?? true) ? 'permissive' : 'disabled');
      lines.push(
        `  ${state.padEnd(10)}  ${descriptor.name.padEnd(40)}  (${descriptor.cliEquivalent})`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseOpFlag(
  value: string,
  previous: Array<[DashboardWriteOperation, DashboardWritePolicyState]>,
) {
  const eq = value.indexOf('=');
  if (eq < 1 || eq === value.length - 1) {
    console.error(`Error: --op expects <operation>=<permissive|encrypted|disabled>, got: ${value}`);
    process.exit(1);
  }
  const op = value.slice(0, eq);
  const state = parseStateToken(value.slice(eq + 1));
  if (state === null) {
    console.error(
      `Error: --op value must be one of permissive|encrypted|disabled (or legacy true|false), got: ${value.slice(eq + 1)}`,
    );
    process.exit(1);
  }
  if (!DASHBOARD_WRITE_OPERATIONS_BY_NAME.has(op as DashboardWriteOperation)) {
    console.error(
      `Error: unknown operation "${op}". Run "kici-admin org-settings dashboard-writes show" to list valid operations.`,
    );
    process.exit(1);
  }
  previous.push([op as DashboardWriteOperation, state]);
  return previous;
}

function registerDashboardWritesCommands(
  orgSettings: Command,
  getClient: () => AdminApiClient,
): void {
  const dw = orgSettings
    .command('dashboard-writes')
    .description(
      'Manage per-orch dashboard write policy (which Platform-routed dashboard.* writes the orch accepts)',
    );

  dw.command('show')
    .description('Print current dashboard-write policy. Empty = all enabled.')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option(
      '--category <name>',
      'Filter to one category (Secrets|Variables|Environments|Bindings|"Held runs"|DLQ|Registrations|Topology)',
    )
    .option(
      '--sensitivity <name>',
      'Filter to one sensitivity bucket (plaintext|authority|dispatch)',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (opts: {
        customerId?: string;
        org?: string;
        category?: string;
        sensitivity?: string;
        format: string;
      }) => {
        const customerId = resolveCustomerId(opts);
        try {
          const response = await getClient().get<DashboardWritesResponse>(
            `/api/v1/admin/org-settings/dashboard-writes?customerId=${encodeURIComponent(customerId)}`,
          );
          const filter = parseFilters(opts);
          console.log(formatDashboardWrites(response, opts.format, filter));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  dw.command('set')
    .description(
      'Set one or more operations. Use --op <name>=<permissive|encrypted|disabled> per operation ' +
        '(legacy true|false accepted). "encrypted" is valid only for plaintext operations ' +
        '(secrets.set, variables.set). Sugar: --category or --sensitivity + --enabled <bool> ' +
        'expands to the matching operations.',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option(
      '--op <op=state>',
      'Single operation posture; repeatable (e.g. --op secrets.set=encrypted --op variables.set=disabled)',
      parseOpFlag,
      [] as Array<[DashboardWriteOperation, DashboardWritePolicyState]>,
    )
    .option('--category <name>', 'Apply --enabled to every operation in this category')
    .option('--sensitivity <name>', 'Apply --enabled to every operation in this sensitivity bucket')
    .option('--enabled <bool>', 'Pair with --category or --sensitivity to flip the whole group')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (opts: {
        customerId?: string;
        org?: string;
        op: Array<[DashboardWriteOperation, DashboardWritePolicyState]>;
        category?: string;
        sensitivity?: string;
        enabled?: string;
        format: string;
      }) => {
        const customerId = resolveCustomerId(opts);
        try {
          const updates = collectUpdates(opts);
          if (Object.keys(updates).length === 0) {
            console.error(
              'Error: no operations specified. Pass --op <name>=<bool> or --category/--sensitivity + --enabled.',
            );
            process.exit(1);
          }
          const before = await getClient().get<DashboardWritesResponse>(
            `/api/v1/admin/org-settings/dashboard-writes?customerId=${encodeURIComponent(customerId)}`,
          );
          printPlannedChange(updates, before);
          const response = await getClient().patch<DashboardWritesResponse>(
            `/api/v1/admin/org-settings/dashboard-writes`,
            { customerId, updates },
          );
          console.log(formatDashboardWrites(response, opts.format));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  dw.command('reset')
    .description('Reset all operations to enabled (permissive default).')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId?: string; org?: string; format: string }) => {
      const customerId = resolveCustomerId(opts);
      try {
        const response = await getClient().patch<DashboardWritesResponse>(
          `/api/v1/admin/org-settings/dashboard-writes`,
          { customerId, reset: true },
        );
        console.log(formatDashboardWrites(response, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

function parseFilters(opts: {
  category?: string;
  sensitivity?: string;
}): { category?: DashboardWriteCategory; sensitivity?: DashboardWriteSensitivity } | undefined {
  if (!opts.category && !opts.sensitivity) return undefined;
  const filter: { category?: DashboardWriteCategory; sensitivity?: DashboardWriteSensitivity } = {};
  if (opts.category) {
    const parsed = DashboardWriteCategory.safeParse(opts.category);
    if (!parsed.success) {
      throw new Error(`Unknown --category: ${opts.category}`);
    }
    filter.category = parsed.data;
  }
  if (opts.sensitivity) {
    const parsed = DashboardWriteSensitivity.safeParse(opts.sensitivity);
    if (!parsed.success) {
      throw new Error(`Unknown --sensitivity: ${opts.sensitivity}`);
    }
    filter.sensitivity = parsed.data;
  }
  return filter;
}

function collectUpdates(opts: {
  op: Array<[DashboardWriteOperation, DashboardWritePolicyState]>;
  category?: string;
  sensitivity?: string;
  enabled?: string;
}): DashboardWritePolicyMap {
  const updates: DashboardWritePolicyMap = {};
  for (const [op, value] of opts.op) {
    updates[op] = value;
  }
  const groupSelected = Boolean(opts.category || opts.sensitivity);
  if (groupSelected) {
    if (opts.enabled === undefined) {
      throw new Error('--category / --sensitivity require --enabled <true|false>');
    }
    const enabled = opts.enabled.toLowerCase();
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('--enabled must be "true" or "false"');
    }
    // Group sugar flips the whole set enabled (permissive) / disabled — the
    // encrypted posture is per-operation only, set via --op.
    const value: DashboardWritePolicyState = enabled === 'true' ? 'permissive' : 'disabled';
    const cat = opts.category ? DashboardWriteCategory.parse(opts.category) : undefined;
    const sens = opts.sensitivity ? DashboardWriteSensitivity.parse(opts.sensitivity) : undefined;
    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      if (cat && descriptor.category !== cat) continue;
      if (sens && descriptor.sensitivity !== sens) continue;
      updates[descriptor.name] = value;
    }
  }
  return updates;
}

function printPlannedChange(
  updates: DashboardWritePolicyMap,
  before: DashboardWritesResponse,
): void {
  const lines: string[] = ['Planned changes:'];
  let any = false;
  for (const [op, next] of Object.entries(updates) as Array<
    [DashboardWriteOperation, DashboardWritePolicyState]
  >) {
    const prior =
      before.states?.[op] ?? ((before.effective[op] ?? true) ? 'permissive' : 'disabled');
    if (prior === next) continue;
    any = true;
    lines.push(`  ${op}: ${prior} -> ${next}`);
  }
  if (!any) {
    lines.push('  (no effective change)');
  }
  console.error(lines.join('\n'));
}
