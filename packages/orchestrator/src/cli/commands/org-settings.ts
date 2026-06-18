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
  dispatchAckTimeoutMs: number | null;
  approvalExpirySeconds: number;
  allowSelfApproval: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface SettingsResponse {
  settings: GlobalWorkflowSettings;
}

interface PatchBody {
  customerId: string;
  enabled?: boolean;
  allowedRepos?: RepoPatternEntry[] | null;
  deniedRepos?: RepoPatternEntry[] | null;
  elevatedRepos?: RepoPatternEntry[] | null;
  allowHttpNpmRegistries?: boolean;
  userCacheQuotaBytes?: number | null;
  userCacheTtlMs?: number | null;
  dispatchAckTimeoutMs?: number | null;
  approvalExpirySeconds?: number;
  allowSelfApproval?: boolean;
}

type ListField = 'allowedRepos' | 'deniedRepos' | 'elevatedRepos';
type Prefix = 'allow' | 'deny' | 'elevate';

function formatSettings(s: GlobalWorkflowSettings, format: string): string {
  if (format === 'json') return JSON.stringify(s, null, 2);
  const lines: string[] = [];
  lines.push(`Customer/org id:       ${s.customerId}`);
  lines.push(`Enabled:               ${s.enabled}`);
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
    `Dispatch ack timeout:  ${s.dispatchAckTimeoutMs === null ? '(cluster default)' : `${s.dispatchAckTimeoutMs} ms`}`,
  );
  lines.push(`Approval expiry:       ${s.approvalExpirySeconds} s`);
  lines.push(`Allow self-approval:   ${s.allowSelfApproval}`);
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

  // ── set-enabled ──────────────────────────────────────────────────
  gw.command('set-enabled <value>')
    .description('Toggle the master enable switch (true|false)')
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (value: string, opts: { customerId?: string; org?: string; format: string }) => {
      const enabled = value === 'true' ? true : value === 'false' ? false : undefined;
      if (enabled === undefined) {
        console.error('Error: value must be "true" or "false"');
        process.exit(1);
      }
      const customerId = resolveCustomerId(opts);
      try {
        const settings = await patchSettings(getClient(), {
          customerId,
          enabled,
        });
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

  // ── dispatch-ack ─────────────────────────────────────────────────
  registerDispatchAckCommands(orgSettings, getClient);

  // ── approval ─────────────────────────────────────────────────────
  registerApprovalCommands(orgSettings, getClient);
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
  return 'elevated-access list';
}

// ─── dashboard-writes ───────────────────────────────────────────────

interface DashboardWritesResponse {
  customerId: string;
  stored: DashboardWritePolicyMap;
  effective: Record<DashboardWriteOperation, boolean>;
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
      const enabled = response.effective[descriptor.name] ?? true;
      const state = enabled ? 'enabled ' : 'disabled';
      lines.push(`  ${state}  ${descriptor.name.padEnd(40)}  (${descriptor.cliEquivalent})`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseOpFlag(value: string, previous: Array<[DashboardWriteOperation, boolean]>) {
  const eq = value.indexOf('=');
  if (eq < 1 || eq === value.length - 1) {
    console.error(`Error: --op expects <operation>=<true|false>, got: ${value}`);
    process.exit(1);
  }
  const op = value.slice(0, eq);
  const bool = value.slice(eq + 1).toLowerCase();
  if (bool !== 'true' && bool !== 'false') {
    console.error(`Error: --op value must be "true" or "false", got: ${bool}`);
    process.exit(1);
  }
  if (!DASHBOARD_WRITE_OPERATIONS_BY_NAME.has(op as DashboardWriteOperation)) {
    console.error(
      `Error: unknown operation "${op}". Run "kici-admin org-settings dashboard-writes show" to list valid operations.`,
    );
    process.exit(1);
  }
  previous.push([op as DashboardWriteOperation, bool === 'true']);
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
      'Set one or more operations. Use --op <name>=<true|false> per operation. ' +
        'Sugar: --category or --sensitivity + --enabled <bool> expands to the matching operations.',
    )
    .option('--customer-id <id>', 'Customer / org id (alias: --org)')
    .option('--org <id>', 'Alias for --customer-id')
    .option(
      '--op <op=bool>',
      'Single operation flip; repeatable (e.g. --op secrets.set=false --op variables.set=false)',
      parseOpFlag,
      [] as Array<[DashboardWriteOperation, boolean]>,
    )
    .option('--category <name>', 'Apply --enabled to every operation in this category')
    .option('--sensitivity <name>', 'Apply --enabled to every operation in this sensitivity bucket')
    .option('--enabled <bool>', 'Pair with --category or --sensitivity to flip the whole group')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      async (opts: {
        customerId?: string;
        org?: string;
        op: Array<[DashboardWriteOperation, boolean]>;
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
  op: Array<[DashboardWriteOperation, boolean]>;
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
    const value = enabled === 'true';
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
  for (const [op, next] of Object.entries(updates) as Array<[DashboardWriteOperation, boolean]>) {
    const prior = before.effective[op] ?? true;
    if (prior === next) continue;
    any = true;
    lines.push(`  ${op}: ${prior ? 'enabled' : 'disabled'} -> ${next ? 'enabled' : 'disabled'}`);
  }
  if (!any) {
    lines.push('  (no effective change)');
  }
  console.error(lines.join('\n'));
}
