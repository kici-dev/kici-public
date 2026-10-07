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
import {
  CLI_INDEPENDENT_ONLY_OPERATIONS,
  DASHBOARD_WRITE_OPERATIONS,
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
  DashboardWriteCategory,
  DashboardWriteOperation,
  DashboardWritePolicyState,
  DashboardWriteSensitivity,
  type DashboardWritePolicyMap,
} from '@kici-dev/engine/protocol/dashboard-write-operations';
import { cliAction } from './shared/cli-action.js';

interface RepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

interface GlobalWorkflowSettings {
  customerId: string;
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  allowHttpNpmRegistries: boolean;
  allowUntrustedDockerfileBuilds: boolean;
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
  rerouteSpawnMaxAttempts: number | null;
  rerouteSpawnRetryBackoffMs: number | null;
  backupStalenessWarnHours: number | null;
  queueTimeoutMs: number | null;
  cacheUploadSettleTimeoutMs: number | null;
  approvalExpirySeconds: number;
  allowSelfApproval: boolean;
  sandboxAllowedCapabilities: string[];
  sandboxAllowHostNetwork: boolean;
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
  allowHttpNpmRegistries?: boolean;
  allowUntrustedDockerfileBuilds?: boolean;
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
  rerouteSpawnMaxAttempts?: number | null;
  rerouteSpawnRetryBackoffMs?: number | null;
  backupStalenessWarnHours?: number | null;
  queueTimeoutMs?: number | null;
  cacheUploadSettleTimeoutMs?: number | null;
  approvalExpirySeconds?: number;
  allowSelfApproval?: boolean;
  sandboxAllowedCapabilities?: string[] | null;
  sandboxAllowHostNetwork?: boolean | null;
}

type ListField = 'allowedRepos' | 'deniedRepos';
type Prefix = 'allow' | 'deny';

/** Render a field an older orchestrator may omit; absent prints `(not reported)`. */
function reported(value: boolean | number | undefined, unit = ''): string {
  return value === undefined ? '(not reported)' : `${value}${unit}`;
}

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
  lines.push(`Allow http registries: ${reported(s.allowHttpNpmRegistries)}`);
  lines.push(`Allow untrusted dockerfile builds: ${reported(s.allowUntrustedDockerfileBuilds)}`);
  lines.push(
    `User-cache quota:      ${s.userCacheQuotaBytes == null ? '(cluster default)' : `${s.userCacheQuotaBytes} bytes`}`,
  );
  lines.push(
    `User-cache TTL:        ${s.userCacheTtlMs == null ? '(cluster default)' : `${s.userCacheTtlMs} ms`}`,
  );
  lines.push(
    `Artifact quota:        ${s.artifactQuotaBytes == null ? '(cluster default)' : `${s.artifactQuotaBytes} bytes`}`,
  );
  lines.push(
    `Artifact TTL:          ${s.artifactTtlMs == null ? '(cluster default)' : `${s.artifactTtlMs} ms`}`,
  );
  lines.push(
    `Artifact max bytes:    ${s.artifactMaxBytes == null ? '(cluster default)' : `${s.artifactMaxBytes} bytes`}`,
  );
  lines.push(
    `Artifact max/run:      ${s.artifactMaxPerRun == null ? '(cluster default)' : `${s.artifactMaxPerRun}`}`,
  );
  lines.push(
    `Dispatch ack timeout:  ${s.dispatchAckTimeoutMs == null ? '(cluster default)' : `${s.dispatchAckTimeoutMs} ms`}`,
  );
  lines.push(
    `Ingest max concurrency:${s.ingestMaxConcurrency == null ? ' (cluster default)' : ` ${s.ingestMaxConcurrency}`}`,
  );
  lines.push(
    `Scaler spawn timeout:  ${s.scalerSpawnTimeoutMs == null ? '(cluster default)' : `${s.scalerSpawnTimeoutMs} ms`}`,
  );
  lines.push(
    `Reroute spawn window:  ${s.rerouteSpawnWindowMs == null ? '(cluster default)' : `${s.rerouteSpawnWindowMs} ms`}`,
  );
  lines.push(
    `Reroute ack timeout:   ${s.rerouteAckTimeoutMs == null ? '(cluster default)' : `${s.rerouteAckTimeoutMs} ms`}`,
  );
  lines.push(
    `Reroute max hops:      ${s.rerouteMaxHops == null ? '(cluster default)' : `${s.rerouteMaxHops}`}`,
  );
  lines.push(
    `Reroute spawn attempts:${s.rerouteSpawnMaxAttempts == null ? ' (cluster default)' : ` ${s.rerouteSpawnMaxAttempts}`}`,
  );
  lines.push(
    `Reroute spawn backoff: ${s.rerouteSpawnRetryBackoffMs == null ? '(cluster default)' : `${s.rerouteSpawnRetryBackoffMs} ms`}`,
  );
  lines.push(
    `Backup staleness warn: ${s.backupStalenessWarnHours == null ? '(cluster default)' : `${s.backupStalenessWarnHours} h`}`,
  );
  lines.push(
    `Queue timeout:         ${s.queueTimeoutMs == null ? '(cluster default)' : `${s.queueTimeoutMs} ms`}`,
  );
  lines.push(
    `Cache upload settle:   ${s.cacheUploadSettleTimeoutMs == null ? '(cluster default)' : `${s.cacheUploadSettleTimeoutMs} ms`}`,
  );
  lines.push(`Approval expiry:       ${reported(s.approvalExpirySeconds, ' s')}`);
  lines.push(`Allow self-approval:   ${reported(s.allowSelfApproval)}`);
  const sandboxCaps = s.sandboxAllowedCapabilities ?? [];
  lines.push(
    `Sandbox capabilities:  ${sandboxCaps.length === 0 ? '(none — deny all)' : sandboxCaps.join(', ')}`,
  );
  lines.push(`Sandbox host network:  ${reported(s.sandboxAllowHostNetwork)}`);
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

interface OrgOpts {
  org: string;
  format: string;
}

/** Add the required `--org` and the `--format` option every per-org command takes. */
function orgOptions(cmd: Command): Command {
  return cmd
    .requiredOption('--org <id>', 'Org id')
    .option('--format <format>', 'Output format: json|table', 'table');
}

/** PATCH the settings and print the result; a failed request prints `Error: <message>` and exits 1. */
const patchAndPrint = cliAction(
  async (getClient: () => AdminApiClient, body: PatchBody, format: string) => {
    console.log(formatSettings(await patchSettings(getClient(), body), format));
  },
);

/** Parse an integer CLI value with a minimum, printing `Error: <invalidMessage>` and exiting 1 on failure. */
function parseIntOrExit(value: string, min: number, invalidMessage: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    console.error(`Error: ${invalidMessage}`);
    process.exit(1);
  }
  return n;
}

/** Parse an integer CLI flag with a minimum; the error names the flag after the label's first word. */
function parseIntFlag(value: string, min: number, fieldLabel: string): number {
  return parseIntOrExit(value, min, `--${fieldLabel.split(' ')[0]} must be an integer >= ${min}`);
}

/** Parse a `true` / `false` CLI value, exiting 1 on anything else. */
function parseBoolOrExit(value: string): boolean {
  if (value !== 'true' && value !== 'false') {
    console.error('Error: value must be "true" or "false"');
    process.exit(1);
  }
  return value === 'true';
}

/** Register `show`, which prints the org's current settings. */
function registerShow(group: Command, getClient: () => AdminApiClient, description: string): void {
  orgOptions(group.command('show').description(description)).action(
    cliAction(async (opts: OrgOpts) => {
      console.log(formatSettings(await fetchSettings(getClient(), opts.org), opts.format));
    }),
  );
}

/** Register a command that PATCHes `clear` (each override back to its default). */
function registerReset(
  group: Command,
  getClient: () => AdminApiClient,
  name: string,
  description: string,
  clear: Omit<PatchBody, 'customerId'>,
): void {
  orgOptions(group.command(name).description(description)).action((opts: OrgOpts) =>
    patchAndPrint(getClient, { customerId: opts.org, ...clear }, opts.format),
  );
}

/** Register a command taking one `<value>` argument that a parser turns into a PATCH body. */
function registerValueSetter(
  group: Command,
  getClient: () => AdminApiClient,
  usage: string,
  description: string,
  toPatch: (value: string) => Omit<PatchBody, 'customerId'>,
): void {
  orgOptions(group.command(usage).description(description)).action((value: string, opts: OrgOpts) =>
    patchAndPrint(getClient, { customerId: opts.org, ...toPatch(value) }, opts.format),
  );
}

type IntKnobField =
  | 'dispatchAckTimeoutMs'
  | 'scalerSpawnTimeoutMs'
  | 'ingestMaxConcurrency'
  | 'backupStalenessWarnHours'
  | 'queueTimeoutMs'
  | 'cacheUploadSettleTimeoutMs';

/** A nullable per-org integer override managed as `<command> <show|set|reset>`. */
interface IntOrgKnobSpec {
  groupDescription: string;
  showDescription: string;
  setDescription: string;
  /** Where `set` reads its value: a positional argument or a required option. */
  value: { kind: 'argument' | 'option'; flags: string; description?: string };
  field: IntKnobField;
  min: number;
  /** Printed as `Error: <invalidMessage>` when the value is not an integer >= `min`. */
  invalidMessage: string;
  resetDescription: string;
}

/**
 * The per-org integer overrides. A null value means the cluster-wide default
 * applies; `reset` clears the override back to null.
 */
const INT_ORG_KNOBS = {
  // The dispatch-acknowledgment deadline (cluster default `KICI_DISPATCH_ACK_TIMEOUT_MS`).
  'dispatch-ack': {
    groupDescription:
      'Manage the per-org dispatch-acknowledgment deadline (null = cluster default)',
    showDescription: 'Print the current per-org dispatch-acknowledgment deadline',
    setDescription:
      'Set the per-org dispatch-acknowledgment deadline (integer milliseconds, >= 1000)',
    value: { kind: 'argument', flags: '<value>' },
    field: 'dispatchAckTimeoutMs',
    min: 1000,
    invalidMessage: 'value must be an integer >= 1000 (milliseconds)',
    resetDescription:
      'Clear the per-org dispatch-ack deadline override (fall back to the cluster default)',
  },
  // The deadline for one scaler `backend.spawn`; a hung spawn past it is aborted so it
  // stops holding its spawn-semaphore slot (cluster default `KICI_SCALER_SPAWN_TIMEOUT_MS`).
  'scaler-spawn-timeout': {
    groupDescription: 'Manage the per-org scaler spawn deadline (null = cluster default)',
    showDescription: 'Print the current per-org scaler spawn deadline',
    setDescription: 'Set the per-org scaler spawn deadline (integer milliseconds, >= 1000)',
    value: { kind: 'argument', flags: '<value>' },
    field: 'scalerSpawnTimeoutMs',
    min: 1000,
    invalidMessage: 'value must be an integer >= 1000 (milliseconds)',
    resetDescription:
      'Clear the per-org scaler spawn deadline override (fall back to the cluster default)',
  },
  // The concurrent `processWebhook` pipelines admitted before shedding with 429
  // (cluster default `KICI_INGEST_ORG_MAX_CONCURRENCY`).
  'ingest-concurrency': {
    groupDescription: 'Manage the per-org webhook-ingest concurrency cap (null = cluster default)',
    showDescription: 'Print the current per-org webhook-ingest concurrency cap',
    setDescription: 'Set the per-org webhook-ingest concurrency cap (integer, >= 1)',
    value: { kind: 'argument', flags: '<value>' },
    field: 'ingestMaxConcurrency',
    min: 1,
    invalidMessage: 'value must be an integer >= 1',
    resetDescription:
      'Clear the per-org webhook-ingest concurrency override (fall back to the cluster default)',
  },
  // The DB-backup freshness WARN threshold (cluster default `config.backupStalenessWarnHours`).
  'backup-freshness': {
    groupDescription:
      'Manage the per-org DB-backup freshness WARN threshold (null = cluster default)',
    showDescription: 'Print the current per-org backup-freshness threshold',
    setDescription: 'Set the per-org backup-freshness WARN threshold in hours (>= 1)',
    value: {
      kind: 'option',
      flags: '--hours <n>',
      description: 'Threshold in hours (integer >= 1)',
    },
    field: 'backupStalenessWarnHours',
    min: 1,
    invalidMessage: '--hours must be an integer >= 1',
    resetDescription: 'Clear the per-org override (fall back to the cluster default)',
  },
  // A queued job's deadline is `job.timeoutMs ?? <this> ?? config.queueTimeoutMs`; 0 = no expiry.
  'queue-timeout': {
    groupDescription: 'Manage the per-org dispatch-queue job timeout (null = cluster default)',
    showDescription: 'Print the current per-org queue timeout',
    setDescription: 'Set the per-org queue timeout in milliseconds (0 = indefinite)',
    value: {
      kind: 'argument',
      flags: '<ms>',
      description: 'Queue timeout in milliseconds (integer >= 0)',
    },
    field: 'queueTimeoutMs',
    min: 0,
    invalidMessage: '--ms must be an integer >= 0',
    resetDescription: 'Clear the per-org queue-timeout override (fall back to the cluster default)',
  },
  // How long a build job's success waits for the cache publish its agent reported; 0 = no wait.
  'cache-upload-settle': {
    groupDescription:
      'Manage how long a build success waits for its cache upload to publish (null = cluster default)',
    showDescription: 'Print the current per-org cache upload settle timeout',
    setDescription: 'Set the per-org cache upload settle timeout in milliseconds (0 = no wait)',
    value: {
      kind: 'argument',
      flags: '<ms>',
      description: 'Settle timeout in milliseconds (integer >= 0)',
    },
    field: 'cacheUploadSettleTimeoutMs',
    min: 0,
    invalidMessage: '--ms must be an integer >= 0',
    resetDescription:
      'Clear the per-org cache upload settle override (fall back to the cluster default)',
  },
} satisfies Record<string, IntOrgKnobSpec>;

/** Register `kici-admin org-settings <command> <show|set|reset>` for one integer knob. */
function registerIntOrgKnob(
  orgSettings: Command,
  getClient: () => AdminApiClient,
  command: keyof typeof INT_ORG_KNOBS,
): void {
  const spec: IntOrgKnobSpec = INT_ORG_KNOBS[command];
  const group = orgSettings.command(command).description(spec.groupDescription);
  registerShow(group, getClient, spec.showDescription);

  const set = group.command('set').description(spec.setDescription);
  const apply = (raw: string, opts: OrgOpts) =>
    patchAndPrint(
      getClient,
      {
        customerId: opts.org,
        [spec.field]: parseIntOrExit(raw, spec.min, spec.invalidMessage),
      },
      opts.format,
    );
  if (spec.value.kind === 'option') {
    const key = set.createOption(spec.value.flags).attributeName();
    orgOptions(set.requiredOption(spec.value.flags, spec.value.description)).action(
      (opts: OrgOpts & Record<string, string>) => apply(opts[key], opts),
    );
  } else {
    orgOptions(set.argument(spec.value.flags, spec.value.description)).action(apply);
  }

  registerReset(group, getClient, 'reset', spec.resetDescription, { [spec.field]: null });
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
  registerShow(gw, getClient, 'Print current global workflow settings for an org');
  registerListMutators(gw, getClient, 'allow', 'allowedRepos');
  registerListMutators(gw, getClient, 'deny', 'deniedRepos');

  registerDashboardWritesCommands(orgSettings, getClient);

  // Under `org-settings`, not `global-workflows`: it gates install-time npm
  // registry behaviour, not the global workflow allow/deny lists.
  registerValueSetter(
    orgSettings,
    getClient,
    'allow-http-npm <value>',
    'Permit plain http:// npm registry URLs in workflow registries:. ' +
      'Default false; loopback / *.local are always allowed regardless.',
    (value) => ({ allowHttpNpmRegistries: parseBoolOrExit(value) }),
  );

  // A Dockerfile image build runs on the agent host OUTSIDE the job's hardened
  // sandbox, so an untrusted ref (a fork PR) is refused unless the operator opts in.
  registerValueSetter(
    orgSettings,
    getClient,
    'allow-untrusted-dockerfile-builds <value>',
    "Permit an untrusted ref (fork PR) to build a job's container image from a " +
      'Dockerfile. Default false. The build is NOT sandboxed — it runs arbitrary ' +
      "RUN commands on the agent host's container daemon.",
    (value) => ({ allowUntrustedDockerfileBuilds: parseBoolOrExit(value) }),
  );

  // Registration order is the order `org-settings --help` lists the groups in.
  registerUserCacheCommands(orgSettings, getClient);
  registerArtifactCommands(orgSettings, getClient);
  registerIntOrgKnob(orgSettings, getClient, 'dispatch-ack');
  registerIntOrgKnob(orgSettings, getClient, 'scaler-spawn-timeout');
  registerIntOrgKnob(orgSettings, getClient, 'ingest-concurrency');
  registerSandboxAllowlistCommands(orgSettings, getClient);
  registerRerouteCommands(orgSettings, getClient);
  registerIntOrgKnob(orgSettings, getClient, 'backup-freshness');
  registerIntOrgKnob(orgSettings, getClient, 'queue-timeout');
  registerIntOrgKnob(orgSettings, getClient, 'cache-upload-settle');
  registerApprovalCommands(orgSettings, getClient);
}

/**
 * `kici-admin org-settings reroute <show|set|reset>`.
 *
 * The per-org cross-peer reroute tunables: the post-ACK spawn window
 * (`reroute_spawn_window_ms`), the reroute ACK timeout
 * (`reroute_ack_timeout_ms`), the max peer hops (`reroute_max_hops`), and the
 * spawn-retry budget a worker applies to a rerouted job
 * (`reroute_spawn_max_attempts`, `reroute_spawn_retry_backoff_ms`). A null
 * (unset) value means the cluster-wide config default applies. `set` flips one
 * or more; `reset` clears every reroute override the orchestrator reports.
 */
function registerRerouteCommands(orgSettings: Command, getClient: () => AdminApiClient): void {
  const rr = orgSettings
    .command('reroute')
    .description('Manage the per-org cross-peer reroute tunables (null = cluster default)');
  registerShow(rr, getClient, 'Print the current per-org reroute tunables');

  rr.command('set')
    .description(
      'Set one or more reroute tunables. At least one of --window / --ack-timeout / --max-hops / --spawn-max-attempts / --spawn-retry-backoff.',
    )
    .requiredOption('--org <id>', 'Org id')
    .option('--window <ms>', 'Spawn window (integer milliseconds, >= 1000)')
    .option('--ack-timeout <ms>', 'Reroute ACK timeout (integer milliseconds, >= 1000)')
    .option('--max-hops <n>', 'Maximum peer hops (integer >= 1)')
    .option(
      '--spawn-max-attempts <n>',
      'Spawn attempts a worker makes for one rerouted job (integer >= 1)',
    )
    .option(
      '--spawn-retry-backoff <ms>',
      'Wait after a failed spawn before the next attempt (integer milliseconds, >= 0)',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      (
        opts: OrgOpts & {
          window?: string;
          ackTimeout?: string;
          maxHops?: string;
          spawnMaxAttempts?: string;
          spawnRetryBackoff?: string;
        },
      ) => patchAndPrint(getClient, buildReroutePatch(opts.org, opts), opts.format),
    );

  registerReset(
    rr,
    getClient,
    'reset',
    'Clear every per-org reroute override (fall back to the cluster defaults)',
    {
      rerouteSpawnWindowMs: null,
      rerouteAckTimeoutMs: null,
      rerouteMaxHops: null,
      rerouteSpawnMaxAttempts: null,
      rerouteSpawnRetryBackoffMs: null,
    },
  );
}

/** Validate `reroute set` flags and assemble the PATCH body (exits on bad input). */
function buildReroutePatch(
  customerId: string,
  opts: {
    window?: string;
    ackTimeout?: string;
    maxHops?: string;
    spawnMaxAttempts?: string;
    spawnRetryBackoff?: string;
  },
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
  if (opts.spawnMaxAttempts !== undefined) {
    patch.rerouteSpawnMaxAttempts = parseIntFlag(opts.spawnMaxAttempts, 1, 'spawn-max-attempts');
  }
  if (opts.spawnRetryBackoff !== undefined) {
    patch.rerouteSpawnRetryBackoffMs = parseIntFlag(
      opts.spawnRetryBackoff,
      0,
      'spawn-retry-backoff (milliseconds)',
    );
  }
  if (Object.keys(patch).length === 1) {
    console.error(
      'Error: pass at least one of --window / --ack-timeout / --max-hops / --spawn-max-attempts / --spawn-retry-backoff',
    );
    process.exit(1);
  }
  return patch;
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
  registerShow(ap, getClient, 'Print the current per-org approval policy');
  registerValueSetter(
    ap,
    getClient,
    'set-expiry <seconds>',
    'Set the per-org held-approval expiry (integer seconds, >= 1)',
    (value) => ({
      approvalExpirySeconds: parseIntOrExit(value, 1, 'value must be an integer >= 1 (seconds)'),
    }),
  );
  registerValueSetter(
    ap,
    getClient,
    'set-self-approval <value>',
    'Allow or forbid a run triggerer approving its own held elements (true|false)',
    (value) => ({ allowSelfApproval: parseBoolOrExit(value) }),
  );
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
  registerShow(
    sa,
    getClient,
    'Print the current per-org sandbox capability + host-network allow-list',
  );
  registerValueSetter(
    sa,
    getClient,
    'set-capabilities <capabilities>',
    'Set the allowed capabilities (comma-separated, e.g. NET_ADMIN,SYS_PTRACE; empty clears)',
    (capabilities) => ({
      sandboxAllowedCapabilities: capabilities
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    }),
  );
  registerValueSetter(
    sa,
    getClient,
    'allow-host-network <value>',
    'Allow (true) or deny (false) workflow-requested host networking',
    (value) => ({ sandboxAllowHostNetwork: parseBoolOrExit(value) }),
  );
  registerReset(
    sa,
    getClient,
    'reset',
    'Clear the allow-list (deny all capabilities and host networking)',
    { sandboxAllowedCapabilities: null, sandboxAllowHostNetwork: false },
  );
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
  registerShow(uc, getClient, 'Print the current per-org user-cache quota + TTL settings');
  registerPositiveIntKnob(uc, getClient, 'user-cache', 'quota', 'userCacheQuotaBytes', 'bytes');
  registerPositiveIntKnob(uc, getClient, 'user-cache', 'ttl', 'userCacheTtlMs', 'milliseconds');
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
  registerShow(art, getClient, 'Print the current per-org artifact quota + TTL settings');
  registerPositiveIntKnob(art, getClient, 'artifact', 'quota', 'artifactQuotaBytes', 'bytes');
  registerPositiveIntKnob(art, getClient, 'artifact', 'ttl', 'artifactTtlMs', 'milliseconds');
  registerPositiveIntKnob(art, getClient, 'artifact', 'max-bytes', 'artifactMaxBytes', 'bytes');
  registerPositiveIntKnob(
    art,
    getClient,
    'artifact',
    'max-per-run',
    'artifactMaxPerRun',
    'artifacts',
  );
}

/**
 * Register `set-<knob> <value>` (a positive integer) and `reset-<knob>` (null,
 * the cluster default) for one user-cache or artifact knob.
 */
function registerPositiveIntKnob(
  group: Command,
  getClient: () => AdminApiClient,
  noun: 'user-cache' | 'artifact',
  knob: string,
  field:
    | 'userCacheQuotaBytes'
    | 'userCacheTtlMs'
    | 'artifactQuotaBytes'
    | 'artifactTtlMs'
    | 'artifactMaxBytes'
    | 'artifactMaxPerRun',
  unit: string,
): void {
  registerValueSetter(
    group,
    getClient,
    `set-${knob} <value>`,
    `Set the per-org ${noun} ${knob} (positive integer ${unit})`,
    (value) => ({
      [field]: parseIntOrExit(value, 1, `value must be a positive integer (${unit})`),
    }),
  );
  registerReset(
    group,
    getClient,
    `reset-${knob}`,
    `Clear the per-org ${noun} ${knob} override (fall back to the cluster default)`,
    { [field]: null },
  );
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
    .requiredOption('--org <id>', 'Org id')
    .option(
      '--source <routingKey>',
      'Pin the entry to one webhook source (e.g. github:42). Omit for any source.',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (pattern: string, opts: { org: string; source?: string; format: string }) => {
        const customerId = opts.org;

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
      }),
    );

  gw.command(`${prefix}-remove <pattern>`)
    .description(
      `Remove a glob pattern from the ${label(prefix)}. Use --source to target a source-qualified entry.`,
    )
    .requiredOption('--org <id>', 'Org id')
    .option(
      '--source <routingKey>',
      'Match an entry pinned to this routing key. Omit to match an unqualified entry.',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (pattern: string, opts: { org: string; source?: string; format: string }) => {
        const customerId = opts.org;

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
      }),
    );
}

function label(prefix: Prefix): string {
  return prefix === 'allow' ? 'workflow-author allow-list' : 'source-repo deny-list';
}

// ─── dashboard-writes ───────────────────────────────────────────────

interface DashboardWritesResponse {
  customerId: string;
  stored: DashboardWritePolicyMap;
  effective: Record<DashboardWriteOperation, boolean>;
  /** Tri-state posture per operation (permissive | encrypted | disabled). */
  states: Record<DashboardWriteOperation, DashboardWritePolicyState>;
  /**
   * Whether a Platform is attached. Disabling a held-run write is a lockout
   * there, because `kici-admin held-run approve` refuses in that mode.
   */
  platformManaged: boolean;
}

/**
 * Warn about a held-run write that is ALREADY disabled on a Platform-attached
 * orchestrator, where nothing can answer a context or reviewer hold any more.
 *
 * The write path refuses this combination now, so it can only be reached by a
 * policy set before that refusal existed — which is exactly the case that would
 * otherwise never surface. Reported here rather than repaired: re-enabling a
 * write an operator disabled deliberately is their call.
 */
function heldRunLockoutWarning(response: DashboardWritesResponse): string[] {
  if (!response.platformManaged) return [];
  const locked = CLI_INDEPENDENT_ONLY_OPERATIONS.filter((op) => response.states[op] === 'disabled');
  if (locked.length === 0) return [];
  return [
    '',
    `WARNING: ${locked.join(' and ')} ${locked.length > 1 ? 'are' : 'is'} disabled and a ` +
      'Platform is attached, so no surface can answer a context or reviewer hold: the ' +
      'dashboard, `kici approve` / `kici reject` and the MCP tools all relay through these ' +
      'operations, and `kici-admin held-run approve` refuses wherever a Platform is ' +
      'attached. Those holds can only expire. A security-queue hold still answers to a ' +
      '`/kici approve` pull-request comment.',
    `Re-enable with: kici-admin org-settings dashboard-writes set --op ${locked[0]}=permissive`,
  ];
}

function parseStateToken(token: string): DashboardWritePolicyState | null {
  const parsed = DashboardWritePolicyState.safeParse(token.toLowerCase());
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
      const state = response.states[descriptor.name];
      lines.push(
        `  ${state.padEnd(10)}  ${descriptor.name.padEnd(40)}  (${descriptor.cliEquivalent})`,
      );
    }
    lines.push('');
  }
  lines.push(...heldRunLockoutWarning(response));
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
      `Error: --op value must be one of permissive|encrypted|disabled, got: ${value.slice(eq + 1)}`,
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
    .requiredOption('--org <id>', 'Org id')
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
      cliAction(
        async (opts: { org: string; category?: string; sensitivity?: string; format: string }) => {
          const customerId = opts.org;

          const response = await getClient().get<DashboardWritesResponse>(
            `/api/v1/admin/org-settings/dashboard-writes?customerId=${encodeURIComponent(customerId)}`,
          );
          const filter = parseFilters(opts);
          console.log(formatDashboardWrites(response, opts.format, filter));
        },
      ),
    );

  dw.command('set')
    .description(
      'Set one or more operations. Use --op <name>=<permissive|encrypted|disabled> per operation. ' +
        '"encrypted" is valid only for plaintext operations ' +
        '(secrets.set, variables.set). Sugar: --category or --sensitivity + --enabled <bool> ' +
        'expands to the matching operations.',
    )
    .requiredOption('--org <id>', 'Org id')
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
      cliAction(
        async (opts: {
          org: string;
          op: Array<[DashboardWriteOperation, DashboardWritePolicyState]>;
          category?: string;
          sensitivity?: string;
          enabled?: string;
          format: string;
        }) => {
          const customerId = opts.org;

          const updates = collectUpdates(opts);
          if (Object.keys(updates).length === 0) {
            console.error(
              'Error: no operations specified. Pass --op <name>=<permissive|encrypted|disabled> or --category/--sensitivity + --enabled.',
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
        },
      ),
    );

  dw.command('reset')
    .description('Reset all operations to enabled (permissive default).')
    .requiredOption('--org <id>', 'Org id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (opts: { org: string; format: string }) => {
        const customerId = opts.org;

        const response = await getClient().patch<DashboardWritesResponse>(
          `/api/v1/admin/org-settings/dashboard-writes`,
          { customerId, reset: true },
        );
        console.log(formatDashboardWrites(response, opts.format));
      }),
    );
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
    const prior = before.states[op];
    if (prior === next) continue;
    any = true;
    lines.push(`  ${op}: ${prior} -> ${next}`);
  }
  if (!any) {
    lines.push('  (no effective change)');
  }
  console.error(lines.join('\n'));
}
