/**
 * Cluster-settings management commands for kici-admin.
 *
 * Subcommand namespace: `kici-admin cluster-settings <show|set|reset>`.
 *
 * Talks to the orchestrator admin API directly (not the Platform dashboard
 * proxy), so the CLI stays operable even when Platform is unavailable. Backed
 * by `packages/orchestrator/src/routes/admin-cluster-settings.ts`.
 *
 * These knobs are fleet-wide (a single `cluster_settings` row), not per-tenant.
 * For per-tenant knobs use `kici-admin org-settings`.
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import { jwksUrlFor } from '../../cluster/verified-issuer.js';
import { CACHE_MAX_ENTRIES_CEILING } from '../../cluster/cluster-settings-reader.js';

/** One numeric knob: its wire (camelCase) field, CLI flag, bounds, and label. */
interface KnobSpec {
  field: string;
  flag: string;
  min: number;
  /**
   * Optional ceiling, mirroring the route's Zod `.max()`. Only the three LRU
   * entry-count knobs carry one, and theirs is a boot-safety bound rather than
   * a policy preference — see {@link CACHE_MAX_ENTRIES_CEILING}.
   */
  max?: number;
  label: string;
}

/**
 * One text knob. Kept separate from {@link KnobSpec} because the value parser,
 * the PATCH body type, and the `show` formatter all differ — a string knob has
 * no `min` floor and is validated by shape, not by magnitude.
 */
interface StringKnobSpec {
  field: string;
  flag: string;
  label: string;
  /** Human-facing description of the accepted shape, used in the error message. */
  expects: string;
  validate: (value: string) => boolean;
}

/**
 * One boolean knob. A third spec type for the same reason {@link StringKnobSpec}
 * is separate from {@link KnobSpec}: the value parser, the PATCH body type, and
 * the `show` formatter all differ. A boolean also has no bounds to validate —
 * only two accepted spellings.
 */
interface BooleanKnobSpec {
  field: string;
  flag: string;
  label: string;
}

/**
 * The cluster-global knobs. `field` matches the admin route's camelCase
 * schema; `flag` is the kebab-case CLI option; `min` mirrors the route's Zod
 * floor.
 */
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
    field: 'contributorCacheTtlMs',
    flag: 'contributor-cache-ttl-ms',
    min: 1000,
    label: 'Contributor-cache TTL (ms)',
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
  // Cache sizing and TTLs are structural to the underlying LRU, which is built
  // once at boot, so a change here lands at the next orchestrator restart.
  //
  // Spelling: `lockfile`, one word, for every knob about the lock-file CACHE —
  // and for anything added next to them. It reads oddly beside
  // `--lock-file-max-bytes` above (a limit on a single fetch, not a cache), and
  // that inconsistency is deliberate rather than overlooked: `lockfile` is the
  // conventional single-word spelling, and each of these knobs spells it that
  // way across all five links of its chain — CLI flag, `KICI_LOCKFILE_CACHE_*`
  // env var, `lockfile_cache_*` column, config field, and runtime read. Aligning
  // the flag alone with the older neighbour would break that chain; aligning all
  // five would cost a migration to rename a column no customer types. The older
  // flag is released, so it stays as it is.
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
  // The two round budgets are read per round and handed to the agent in the
  // round's job config, so a change lands on the next push. The cache size is
  // structural to its LRU and applies at the next restart.
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

function formatSettings(s: ClusterSettings, format: string): string {
  if (format === 'json') return JSON.stringify(s, null, 2);
  const lines: string[] = [];
  const labels = [...KNOBS, ...STRING_KNOBS, ...BOOLEAN_KNOBS].map((k) => k.label);
  const width = Math.max(...labels.map((l) => l.length)) + 2;
  for (const knob of [...KNOBS, ...STRING_KNOBS, ...BOOLEAN_KNOBS]) {
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

async function patchSettings(client: AdminApiClient, body: PatchBody): Promise<ClusterSettings> {
  const res = await client.patch<SettingsResponse>('/api/v1/admin/cluster-settings', body);
  return res.settings;
}

/**
 * Parse an integer CLI flag against its knob's bounds, exiting on failure.
 *
 * `max` is optional because most knobs have no meaningful ceiling; the ones
 * that do carry a hard boot-safety bound (see {@link KnobSpec.max}).
 */
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
 * Parse a boolean CLI flag, exiting on failure.
 *
 * Accepts only the exact strings `true` and `false`. A permissive parser (any
 * non-empty string is true) would read `--global-workflows-enabled no` as an
 * enable, which for this knob turns a typo into a security posture change.
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
 * Warn when only one of the two ordered global-eval timeouts is being set.
 *
 * The orchestrator's wait ceiling must exceed the agent's round budget — the
 * agent's budget starts only once the round job is RUNNING, so a lower ceiling
 * fires on every round that merely waited for a free agent, failing every round
 * silently. The server rejects the pair outright when BOTH effective values are
 * stored, but it cannot compare against a column left NULL: NULL means "the
 * orchestrator's configured default applies", and the route does not know that
 * number. Setting one alone is exactly that blind spot, so warn here.
 *
 * Returns the lines rather than printing them so the check is unit-testable.
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

  // The adjacent axis, with the same blind spot: a per-candidate budget at or
  // above the whole round's lets ONE candidate consume the entire round, and
  // every sibling workflow in it is then suppressed with no retry.
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
  const all = [...KNOBS, ...STRING_KNOBS, ...BOOLEAN_KNOBS];
  const flagged = all.filter((k) => opts[optionKey(k.flag)]);
  const target = flagged.length > 0 ? flagged : all;
  const patch: PatchBody = {};
  for (const knob of target) patch[knob.field] = null;
  return patch;
}

/** How long to wait for the issuer's JWKS before giving up on the check. */
const VERIFIED_ISSUER_PROBE_TIMEOUT_MS = 5000;

/**
 * Check that `issuer` actually publishes a dashboard-encryption key.
 *
 * Runs after the setting has already been written, so it never throws: a
 * network fault, a non-2xx status and a malformed body all come back as a
 * `reason` the caller prints as a warning. The check is advisory — the CLI may
 * sit in a different network position than the browser that will do the real
 * fetch, so a failure is definitive but a pass is not a guarantee.
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
    .description('Print the current cluster-global tunables')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { format: string }) => {
      try {
        const settings = await fetchSettings(getClient());
        console.log(formatSettings(settings, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
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
    // Advisory post-set probe. The Verified tier hard-blocks every encrypted
    // dashboard write when the origin publishes no key, and nothing else would
    // tell the operator until a browser failed much later. Warn, never fail:
    // the set has already landed, and this shell may not sit where the browser
    // does. Clearing goes through `reset`, so a value here is always a URL.
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
  for (const knob of [...KNOBS, ...STRING_KNOBS, ...BOOLEAN_KNOBS]) {
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
