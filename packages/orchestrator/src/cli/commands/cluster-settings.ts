/**
 * `kici-admin cluster-settings <show|set|reset>`, against the orchestrator
 * admin API directly (`routes/admin-cluster-settings.ts`), never the Platform
 * proxy, so it works while the Platform is down. `show` also lists the settings
 * version each coordinator and worker applied.
 *
 * The knobs are fleet-wide (one `cluster_settings` row); per-tenant knobs live
 * in `kici-admin org-settings`.
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { formatUptime, toErrorMessage } from '@kici-dev/shared';
import { jwksUrlFor } from '../../cluster/verified-issuer.js';
import { CACHE_MAX_ENTRIES_CEILING } from '../../cluster/cluster-settings-reader.js';
import {
  SettingsPropagationStatus,
  settingsPropagationReportSchema,
  type SettingsPropagationEntry,
  type SettingsPropagationReport,
} from '../../cluster/settings-propagation.js';

/** One numeric knob: its wire (camelCase) field, CLI flag, bounds, and label. */
interface KnobSpec {
  field: string;
  flag: string;
  min: number;
  /**
   * Mirrors the route's Zod `.max()`. Only the LRU entry-count knobs carry
   * one: a boot-safety bound, not a policy ({@link CACHE_MAX_ENTRIES_CEILING}).
   */
  max?: number;
  label: string;
}

/**
 * One text knob, separate from {@link KnobSpec} because its parser, PATCH type
 * and `show` formatter differ: it has no `min` and is validated by shape.
 */
interface StringKnobSpec {
  field: string;
  flag: string;
  label: string;
  /** The accepted shape, as the error message names it. */
  expects: string;
  validate: (value: string) => boolean;
}

/**
 * One boolean knob, separate for the same reason as {@link StringKnobSpec}; no
 * bounds, two spellings.
 */
interface BooleanKnobSpec {
  field: string;
  flag: string;
  label: string;
}

/** The cluster-global knobs; `field` matches the admin route schema, `min` its Zod floor. */
const KNOBS: KnobSpec[] = [
  {
    field: 'maxGithubPayloadBytes',
    flag: 'max-github-payload-bytes',
    min: 1024,
    label: 'Max GitHub payload bytes',
  },
  {
    field: 'eventLogMaxPayloadBytes',
    flag: 'event-log-max-payload-bytes',
    min: 1024,
    label: 'Event-log max payload bytes',
  },
  {
    field: 'lockFileMaxBytes',
    flag: 'lock-file-max-bytes',
    min: 1024,
    label: 'Lock-file max bytes',
  },
  {
    field: 'webhookDedupTtlMs',
    flag: 'webhook-dedup-ttl-ms',
    min: 1000,
    label: 'Webhook dedup TTL (ms)',
  },
  {
    field: 'eventRouterEventTtlSeconds',
    flag: 'event-router-event-ttl-seconds',
    min: 1,
    label: 'Event-router event TTL (s)',
  },
  {
    field: 'eventRouterMaxDispatchAttempts',
    flag: 'event-router-max-dispatch-attempts',
    min: 1,
    label: 'Event-router max dispatch attempts',
  },
  { field: 'queueMaxDepth', flag: 'queue-max-depth', min: 1, label: 'Queue max depth' },
  {
    field: 'rerouteFlapGraceMs',
    flag: 'reroute-flap-grace-ms',
    min: 1000,
    label: 'Reroute flap grace (ms)',
  },
  { field: 'maxFanoutHosts', flag: 'max-fanout-hosts', min: 1, label: 'Max fanout hosts' },
  {
    field: 'eventRouterRateLimitPerWorkflowPerMinute',
    flag: 'event-router-rate-limit-per-workflow-per-minute',
    min: 1,
    label: 'Event-router rate limit (/wf/min)',
  },
  {
    field: 'cacheMaxTarballBytes',
    flag: 'cache-max-tarball-bytes',
    min: 1024,
    label: 'Cache max tarball bytes',
  },
  { field: 'cacheTtlDays', flag: 'cache-ttl-days', min: 1, label: 'Cache TTL (days)' },
  {
    field: 'checkRunTrackingTtlDays',
    flag: 'check-run-tracking-ttl-days',
    // Floor 0, not 1: 0 is the documented value that disables the sweep.
    min: 0,
    label: 'Check-run tracking TTL (days)',
  },
  // Floor 0 on all four: 0 is the documented value that disables a window.
  {
    field: 'runRetentionDays',
    flag: 'run-retention-days',
    min: 0,
    label: 'Run history retention (days)',
  },
  {
    field: 'auditRetentionDays',
    flag: 'audit-retention-days',
    min: 0,
    label: 'Audit log retention (days)',
  },
  {
    field: 'provenanceRetentionDays',
    flag: 'provenance-retention-days',
    min: 0,
    label: 'Provenance retention (days)',
  },
  {
    field: 'heldRunRetentionDays',
    flag: 'held-run-retention-days',
    min: 0,
    label: 'Terminal held-run retention (days)',
  },
  {
    field: 'concurrencyWaitTimeoutMs',
    flag: 'concurrency-wait-timeout-ms',
    min: 1000,
    label: 'Concurrency wait timeout (ms)',
  },
  {
    field: 'agentTokenTtlMs',
    flag: 'agent-token-ttl-ms',
    min: 1000,
    label: 'Agent token TTL (ms)',
  },
  {
    field: 'ownershipDbCheckTimeoutMs',
    flag: 'ownership-db-check-timeout-ms',
    min: 100,
    label: 'Ownership DB check timeout (ms)',
  },
  {
    field: 'sealedSecretsRetryBackoffMs',
    flag: 'sealed-secrets-retry-backoff-ms',
    min: 1000,
    label: 'Sealed-secrets retry back-off (ms)',
  },
  {
    field: 'unroutableGraceMs',
    flag: 'unroutable-grace-ms',
    min: 0,
    label: 'Unroutable fast-fail grace (ms)',
  },
  {
    field: 'ingestOverflowClaimTimeoutMs',
    flag: 'ingest-overflow-claim-timeout-ms',
    min: 60_000,
    label: 'Ingest queue claim timeout (ms)',
  },
  // Cache sizing and TTLs shape an LRU built once at boot: a change lands at
  // the next restart.
  //
  // Spelling: `lockfile`, one word, for every lock-file CACHE knob and anything
  // added beside them. The clash with `--lock-file-max-bytes` (a single-fetch
  // limit) is deliberate: each knob spells it the same across its whole chain —
  // CLI flag, `KICI_LOCKFILE_CACHE_*` env var, `lockfile_cache_*` column, config
  // field, runtime read. Aligning the flag alone breaks that chain; aligning all
  // costs a column-rename migration. The older flag is released and stays.
  {
    field: 'lockfileCacheMax',
    flag: 'lockfile-cache-max',
    min: 1,
    max: CACHE_MAX_ENTRIES_CEILING,
    label: 'Lock-file cache max entries',
  },
  {
    field: 'lockfileCacheMaxBytes',
    flag: 'lockfile-cache-max-bytes',
    min: 1024,
    label: 'Lock-file cache max bytes',
  },
  {
    field: 'lockfileCacheTtlMs',
    flag: 'lockfile-cache-ttl-ms',
    min: 1000,
    label: 'Lock-file cache TTL (ms)',
  },
  {
    field: 'contentCacheMax',
    flag: 'content-cache-max',
    min: 1,
    max: CACHE_MAX_ENTRIES_CEILING,
    label: 'Content cache max entries',
  },
  {
    field: 'contentCacheMaxBytes',
    flag: 'content-cache-max-bytes',
    min: 1024,
    label: 'Content cache max bytes',
  },
  {
    field: 'contentCacheTtlMs',
    flag: 'content-cache-ttl-ms',
    min: 1000,
    label: 'Content cache TTL (ms)',
  },
  // The round budgets ride each round's job config, so a change lands on the
  // next push; the cache size applies at the next restart.
  {
    field: 'globalEvalRoundTimeoutMs',
    flag: 'global-eval-round-timeout-ms',
    min: 1000,
    label: 'Global eval round timeout (ms)',
  },
  {
    field: 'globalEvalCandidateTimeoutMs',
    flag: 'global-eval-candidate-timeout-ms',
    min: 1000,
    label: 'Global eval candidate timeout (ms)',
  },
  {
    field: 'globalEvalCacheMax',
    flag: 'global-eval-cache-max',
    min: 1,
    max: CACHE_MAX_ENTRIES_CEILING,
    label: 'Global eval round-result cache max entries',
  },
  // The orchestrator's own ceiling on waiting for a round to settle. Keep it
  // above the round budget: the agent's budget starts only once the round job
  // runs, so a lower ceiling would fire on every round that merely queued.
  {
    field: 'globalEvalWaitTimeoutMs',
    flag: 'global-eval-wait-timeout-ms',
    min: 1000,
    label: 'Global eval wait timeout (ms)',
  },
  // Read per spawn. On a host whose disk is saturated with writes, the jailer's
  // own copy of the firecracker binary into the chroot can take seconds.
  {
    field: 'firecrackerApiSocketWaitMs',
    flag: 'firecracker-api-socket-wait-ms',
    min: 1000,
    label: 'Firecracker API socket wait (ms)',
  },
  // Event-scaler provision reaper: read per sweep, so a change lands on the
  // next tick with no restart (the interval reschedules after the sweep that
  // observed it).
  {
    field: 'scalerReapIntervalMs',
    flag: 'scaler-reap-interval-ms',
    min: 5000,
    label: 'Scaler reap interval (ms)',
  },
  // Keep the stranded window well above the peer heartbeat period: "registered
  // nowhere in the cluster" is partly heartbeat-derived, so a short window can
  // read a peer that has not yet reported its agents as a strand.
  {
    field: 'scalerReapStrandedTimeoutMs',
    flag: 'scaler-reap-stranded-timeout-ms',
    min: 60_000,
    label: 'Scaler reap stranded timeout (ms)',
  },
  {
    field: 'scalerReapReattemptIntervalMs',
    flag: 'scaler-reap-reattempt-interval-ms',
    min: 60_000,
    label: 'Scaler reap re-attempt interval (ms)',
  },
  {
    field: 'scalerClaimRetentionMs',
    flag: 'scaler-claim-retention-ms',
    // Floor 0: an expired claim can never be redeemed, so purging it on expiry
    // is legitimate — it only costs a late redeemer the "expired" diagnostic.
    min: 0,
    label: 'Scaler claim retention (ms)',
  },
  // External-provision backoff. Read per spawn request, so a change lands on
  // the next request with no restart.
  {
    field: 'scalerProvisionBackoffBaseMs',
    flag: 'scaler-provision-backoff-base-ms',
    min: 1000,
    label: 'Scaler provision backoff base (ms)',
  },
  {
    field: 'scalerProvisionBackoffMaxMs',
    flag: 'scaler-provision-backoff-max-ms',
    min: 1000,
    label: 'Scaler provision backoff max (ms)',
  },
  {
    field: 'scalerProvisionMaxConsecutiveFailures',
    flag: 'scaler-provision-max-consecutive-failures',
    min: 1,
    label: 'Scaler provision max consecutive failures',
  },
];

/** The cluster-global text knobs. */
const STRING_KNOBS: StringKnobSpec[] = [
  {
    field: 'dashboardVerifiedIssuer',
    flag: 'dashboard-verified-issuer',
    label: 'Dashboard verified issuer',
    expects: 'an absolute http(s) URL',
    validate: (v) => /^https?:\/\/[^\s]+$/.test(v),
  },
];

const BOOLEAN_KNOBS: BooleanKnobSpec[] = [
  {
    field: 'globalWorkflowsEnabled',
    flag: 'global-workflows-enabled',
    label: 'Global workflows enabled',
  },
];

type ClusterSettings = Record<string, number | string | boolean | null>;
interface SettingsResponse {
  settings: ClusterSettings;
}
/** camelCase → value (null clears the override). */
type PatchBody = Record<string, number | string | boolean | null>;

/** Map a Commander long-flag (`--foo-bar`) to its camelCase option key. */
function optionKey(flag: string): string {
  return flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Every knob, in the order `show` and `reset` enumerate them. */
type AnyKnob = KnobSpec | StringKnobSpec | BooleanKnobSpec;
function allKnobs(): AnyKnob[] {
  return [...KNOBS, ...STRING_KNOBS, ...BOOLEAN_KNOBS];
}

function formatSettings(s: ClusterSettings, format: string): string {
  if (format === 'json') return JSON.stringify(s, null, 2);
  const lines: string[] = [];
  const knobs = allKnobs();
  const width = Math.max(...knobs.map((k) => k.label.length)) + 2;
  for (const knob of knobs) {
    const value = s[knob.field];
    const shown = value === null || value === undefined ? '(cluster default)' : String(value);
    lines.push(`${(knob.label + ':').padEnd(width)} ${shown}`);
  }
  return lines.join('\n');
}

async function fetchSettings(client: AdminApiClient): Promise<ClusterSettings> {
  const res = await client.get<SettingsResponse>('/api/v1/admin/cluster-settings');
  return res.settings;
}

/** The outcome of the propagation request `show` makes after the settings read. */
export type PropagationFetch =
  | { kind: 'ok'; report: SettingsPropagationReport }
  | { kind: 'unsupported' }
  | { kind: 'error'; reason: string };

export const PROPAGATION_UNSUPPORTED_NOTE =
  'Note: this orchestrator does not report cluster-settings propagation; ' +
  'upgrade it to see which version each orchestrator applied.';

/** A 404 means an orchestrator older than this CLI; `show` then prints the settings alone. */
export async function fetchPropagation(client: AdminApiClient): Promise<PropagationFetch> {
  let body: { propagation?: unknown } | null;
  try {
    body = await client.get<{ propagation?: unknown } | null>(
      '/api/v1/admin/cluster-settings/propagation',
    );
  } catch (err) {
    const reason = toErrorMessage(err);
    return reason.startsWith('HTTP 404:') ? { kind: 'unsupported' } : { kind: 'error', reason };
  }
  const parsed = settingsPropagationReportSchema.safeParse(body?.propagation);
  return parsed.success
    ? { kind: 'ok', report: parsed.data }
    : {
        kind: 'error',
        reason: `unexpected response: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      };
}

const LAGGING: ReadonlySet<string> = new Set([
  SettingsPropagationStatus.behind,
  SettingsPropagationStatus.ahead,
]);

function describeLiveness(entry: SettingsPropagationEntry): string {
  if (entry.self) return 'this coordinator';
  const age =
    entry.lastHeartbeatAgeMs === null
      ? 'unknown'
      : `${formatUptime(Math.round(entry.lastHeartbeatAgeMs / 1000))} ago`;
  return entry.connected ? `heartbeat ${age}` : `disconnected, last heartbeat ${age}`;
}

/** The table section: one row per orchestrator, lagging ones in upper case. */
export function formatPropagation(report: SettingsPropagationReport): string {
  const rows = report.orchestrators;
  const idWidth = Math.max(0, ...rows.map((r) => r.instanceId.length));
  const lines = [
    `Propagation (current version ${report.currentVersion}, as seen by ${report.reportedBy}):`,
  ];
  for (const r of rows) {
    const status = LAGGING.has(r.status) ? r.status.toUpperCase() : r.status.replace('-', ' ');
    lines.push(
      `  ${r.instanceId.padEnd(idWidth)}  ${r.role.padEnd(11)}  ${`v${r.appliedVersion}`.padEnd(6)}  ` +
        `${status.padEnd(7)}  ${describeLiveness(r)}`,
    );
  }
  const lagging = rows.filter((r) => LAGGING.has(r.status)).length;
  lines.push(
    lagging === 0
      ? `All ${rows.length} orchestrators run the current version.`
      : `${lagging} of ${rows.length} orchestrators are not on the current version.`,
  );
  return lines.join('\n');
}

/**
 * The JSON keeps the flat settings map plus one `propagation` key, so knob-key
 * scripts keep working.
 */
export function renderShow(
  settings: ClusterSettings,
  propagation: PropagationFetch,
  format: string,
): { stdout: string; stderr: string | null } {
  const stderr =
    propagation.kind === 'unsupported'
      ? PROPAGATION_UNSUPPORTED_NOTE
      : propagation.kind === 'error'
        ? `Warning: could not read cluster-settings propagation: ${propagation.reason}`
        : null;
  if (format === 'json') {
    const out =
      propagation.kind === 'ok' ? { ...settings, propagation: propagation.report } : settings;
    return { stdout: JSON.stringify(out, null, 2), stderr };
  }
  const table = formatSettings(settings, format);
  return {
    stdout:
      propagation.kind === 'ok' ? `${table}\n\n${formatPropagation(propagation.report)}` : table,
    stderr,
  };
}

async function patchSettings(client: AdminApiClient, body: PatchBody): Promise<ClusterSettings> {
  const res = await client.patch<SettingsResponse>('/api/v1/admin/cluster-settings', body);
  return res.settings;
}

/** Exits on a value outside the bounds; `max` is a boot-safety bound ({@link KnobSpec.max}). */
export function parseKnobValue(flag: string, value: string, min: number, max?: number): number {
  const n = Number(value);
  const bounds = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    console.error(`Error: --${flag} must be an integer ${bounds}`);
    process.exit(1);
  }
  return n;
}

/** Validate a text CLI flag against its knob's shape, exiting on failure. */
export function parseStringKnobValue(knob: StringKnobSpec, value: string): string {
  const trimmed = value.trim();
  if (!knob.validate(trimmed)) {
    console.error(`Error: --${knob.flag} must be ${knob.expects}`);
    process.exit(1);
  }
  return trimmed;
}

/**
 * Accepts only `true` and `false`, else exits. A permissive parser would read
 * `--global-workflows-enabled no` as an enable: a typo becomes a security
 * posture change.
 */
export function parseBooleanKnobValue(knob: BooleanKnobSpec, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== 'true' && trimmed !== 'false') {
    console.error(`Error: --${knob.flag} must be true or false`);
    process.exit(1);
  }
  return trimmed === 'true';
}

/** Assemble the PATCH body from provided `set` flags (exits if none given). */
export function buildClusterPatch(opts: Record<string, string | undefined>): PatchBody {
  const patch: PatchBody = {};
  for (const knob of KNOBS) {
    const raw = opts[optionKey(knob.flag)];
    if (raw !== undefined) {
      patch[knob.field] = parseKnobValue(knob.flag, raw, knob.min, knob.max);
    }
  }
  for (const knob of STRING_KNOBS) {
    const raw = opts[optionKey(knob.flag)];
    if (raw !== undefined) {
      patch[knob.field] = parseStringKnobValue(knob, raw);
    }
  }
  for (const knob of BOOLEAN_KNOBS) {
    const raw = opts[optionKey(knob.flag)];
    if (raw !== undefined) {
      patch[knob.field] = parseBooleanKnobValue(knob, raw);
    }
  }
  if (Object.keys(patch).length === 0) {
    console.error(`Error: pass at least one knob flag (e.g. --${KNOBS[0].flag} <value>)`);
    process.exit(1);
  }
  return patch;
}

/**
 * Warns when only one of an ordered global-eval timeout pair is set. The wait
 * ceiling must exceed the round budget, which starts only once the round job
 * is RUNNING, or every round that waited for an agent fails silently. The
 * server rejects a bad pair only when both are stored: a NULL column means the
 * orchestrator's configured default, which the route cannot see.
 *
 * Returns the lines, unprinted, so the check is unit-testable.
 */
export function unpairedEvalTimeoutWarnings(patch: PatchBody): string[] {
  const setting = (v: unknown): boolean => typeof v === 'number';
  const round = patch.globalEvalRoundTimeoutMs;
  const warnings: string[] = [];

  const wait = patch.globalEvalWaitTimeoutMs;
  if (setting(wait) !== setting(round)) {
    const which = setting(wait) ? 'wait timeout' : 'round timeout';
    const other = setting(wait)
      ? '--global-eval-round-timeout-ms'
      : '--global-eval-wait-timeout-ms';
    warnings.push(
      `Warning: setting the global eval ${which} alone. The wait timeout must stay ` +
        `greater than the round timeout, or every round fails. Check ${other} with ` +
        `\`kici-admin cluster-settings show\`.`,
    );
  }

  // Same blind spot: a candidate budget at or above the round's lets ONE
  // candidate consume the round, suppressing every sibling with no retry.
  const candidate = patch.globalEvalCandidateTimeoutMs;
  if (setting(candidate) !== setting(round)) {
    const which = setting(candidate) ? 'candidate timeout' : 'round timeout';
    const other = setting(candidate)
      ? '--global-eval-round-timeout-ms'
      : '--global-eval-candidate-timeout-ms';
    warnings.push(
      `Warning: setting the global eval ${which} alone. The candidate timeout must stay ` +
        `less than the round timeout, or one workflow can suppress every other in its ` +
        `round. Check ${other} with \`kici-admin cluster-settings show\`.`,
    );
  }

  return warnings;
}

/** Build the reset PATCH body: all knobs → null, or just the flagged ones. */
export function buildClusterReset(opts: Record<string, boolean | undefined>): PatchBody {
  const all = allKnobs();
  const flagged = all.filter((k) => opts[optionKey(k.flag)]);
  const target = flagged.length > 0 ? flagged : all;
  const patch: PatchBody = {};
  for (const knob of target) patch[knob.field] = null;
  return patch;
}

/** How long to wait for the issuer's JWKS before giving up on the check. */
const VERIFIED_ISSUER_PROBE_TIMEOUT_MS = 5000;

/**
 * Checks that `issuer` publishes a dashboard-encryption key. It runs after the
 * write, so it never throws: every fault becomes a `reason` warning. Advisory:
 * the CLI may sit elsewhere on the network than the browser, so a failure is
 * definitive and a pass is not a guarantee.
 */
export async function checkVerifiedIssuerPublishes(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = jwksUrlFor(issuer);
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(VERIFIED_ISSUER_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason:
          res.status === 503
            ? `${url} returned HTTP 503 — no key is published there`
            : `${url} returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { keys?: Array<{ use?: string }> };
    const hasEnc = Array.isArray(body.keys) && body.keys.some((k) => k?.use === 'enc');
    return hasEnc
      ? { ok: true }
      : {
          ok: false,
          reason: `${url} publishes no dashboard-encryption key (no key with use: "enc")`,
        };
  } catch (err) {
    return { ok: false, reason: `${url} could not be fetched: ${toErrorMessage(err)}` };
  }
}

export function registerClusterSettingsCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const cs = program
    .command('cluster-settings')
    .description('Manage the fleet-wide cluster tunables (null = cluster default)');

  cs.command('show')
    .description(
      'Print the cluster-global tunables and which settings version each coordinator and worker applied',
    )
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { format: string }) => {
      const client = getClient();
      let settings: ClusterSettings;
      try {
        settings = await fetchSettings(client);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
      const { stdout, stderr } = renderShow(settings, await fetchPropagation(client), opts.format);
      console.log(stdout);
      if (stderr) console.error(stderr);
    });

  const setCmd = cs
    .command('set')
    .description('Set one or more cluster-global tunables. At least one knob flag required.')
    .option('--format <format>', 'Output format: json|table', 'table');
  for (const knob of KNOBS) {
    const bounds =
      knob.max === undefined ? `integer >= ${knob.min}` : `integer ${knob.min}-${knob.max}`;
    setCmd.option(`--${knob.flag} <value>`, `${knob.label} (${bounds})`);
  }
  for (const knob of STRING_KNOBS) {
    setCmd.option(`--${knob.flag} <value>`, `${knob.label} (${knob.expects})`);
  }
  for (const knob of BOOLEAN_KNOBS) {
    setCmd.option(`--${knob.flag} <value>`, `${knob.label} (true|false)`);
  }
  setCmd.action(async (opts: Record<string, string | undefined>) => {
    const patch = buildClusterPatch(opts);
    for (const line of unpairedEvalTimeoutWarnings(patch)) console.warn(line);
    try {
      const updated = await patchSettings(getClient(), patch);
      console.log(formatSettings(updated, opts.format ?? 'table'));
    } catch (err) {
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
    // The Verified tier hard-blocks every encrypted dashboard write when the
    // origin publishes no key, and nothing else tells the operator until a
    // browser fails. Warn, never fail: the set landed, and this shell may not
    // sit where the browser does. Clearing uses `reset`, so this is a URL.
    const issuer = patch.dashboardVerifiedIssuer;
    if (typeof issuer === 'string' && issuer.length > 0) {
      const check = await checkVerifiedIssuerPublishes(issuer);
      if (!check.ok) {
        console.error(
          `\nWarning: ${check.reason}.\n` +
            `  Every encrypted dashboard write will hard-block until a key is published there.\n` +
            `  If this orchestrator has no dashboard-encryption key yet, set KICI_SECRET_KEY and restart it.\n` +
            `  (Checked from this shell — a browser may reach a different network.)`,
        );
      }
    }
  });

  const resetCmd = cs
    .command('reset')
    .description(
      'Clear cluster-global overrides (all, or the named knobs) back to cluster defaults',
    )
    .option('--format <format>', 'Output format: json|table', 'table');
  for (const knob of allKnobs()) {
    resetCmd.option(`--${knob.flag}`, `Clear only ${knob.label}`);
  }
  resetCmd.action(async (opts: Record<string, boolean | string | undefined>) => {
    const patch = buildClusterReset(opts as Record<string, boolean | undefined>);
    try {
      const updated = await patchSettings(getClient(), patch);
      console.log(formatSettings(updated, (opts.format as string) ?? 'table'));
    } catch (err) {
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  });
}
