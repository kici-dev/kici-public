/**
 * Org trust-policy commands for kici-admin.
 *
 * Subcommand namespace:
 * `kici-admin trust-policy <show|set|directory|directory-set|directory-remove>`.
 *
 * Talks to the orchestrator admin API directly (not the Platform dashboard
 * proxy), so the CLI stays operable even when Platform is unavailable. Backed
 * by `packages/orchestrator/src/routes/admin-trust-policy.ts`.
 *
 * `show` and `directory` read, in every mode. `set`, `directory-set`, and
 * `directory-remove` write, and only work on an independent orchestrator:
 * wherever a Platform is attached it owns both the policy and the approval
 * directory, and the route refuses with 409. That message is surfaced verbatim
 * rather than reworded here, so the CLI cannot drift from what the server
 * actually said.
 *
 * The two directory writers live in this namespace rather than one of their
 * own because they are the same org-trust concept as the policy, gated by the
 * same mode rule against the same `--customer-id`, and reached through the same
 * admin route file. Splitting them out would put half of "who may approve" in a
 * second top-level command with its own copy of that story. They are siblings
 * of the `directory` reader rather than subcommands under it, because turning
 * that leaf into a group would break `kici-admin trust-policy directory` for
 * anyone already running it.
 */
import type { Command } from 'commander';
import { formatUptime, toErrorMessage } from '@kici-dev/shared';
import {
  CiTrustLevel,
  ForkPolicy,
  MIN_APPROVAL_EXPIRY_SECONDS,
  SECONDS_PER_HOUR,
} from '@kici-dev/engine';
import type { AdminApiClient } from '../api-client.js';

/**
 * The policy shape the admin route returns.
 *
 * The policy fields are OPTIONAL because a **v0.5.0 independent** orchestrator
 * omits them: there, and only there, no policy row and no attached Platform
 * meant no policy was resolved at all. A v0.5.0 Platform-attached orchestrator
 * with no row still sent the fail-closed values. This build's route always sends
 * them in every mode, so the `unknown` fallbacks below — and the `no policy
 * stored` provenance wording — render only against that older independent
 * orchestrator.
 */
export interface TrustPolicyView {
  customerId: string;
  forkPolicy?: string;
  approvalExpiryHours?: number;
  /**
   * The authoritative hold window. Absent from any orchestrator that predates
   * it, in which case `approvalExpiryHours` is the only window on offer.
   */
  approvalExpirySeconds?: number;
  source: string | null;
  updatedAt: string | null;
  effectiveDefault?: boolean;
  platformManaged?: boolean;
}

interface PolicyResponse {
  policy: TrustPolicyView;
}

/**
 * The fork switch flag: wire field, CLI flag, accepted values, and label. The
 * values are the wire enum itself, so every value the gate honours is settable —
 * including `ignore`, which is what an orchestrator with no stored row already
 * applies and therefore has to be expressible.
 */
const FORK_POLICY_KNOB = {
  field: 'forkPolicy',
  flag: 'fork-policy',
  label: 'Fork PR policy',
  values: ForkPolicy.options,
} as const;

/** Render the policy as an aligned table, or as JSON when asked. */
export function formatPolicy(policy: TrustPolicyView, format: string): string {
  if (format === 'json') return JSON.stringify(policy, null, 2);

  const rows: Array<[string, string]> = [
    ['Fork PR policy', policy.forkPolicy ?? 'unknown'],
    ['Approval expiry', formatExpiry(policy)],
  ];

  // Absent policy fields mean an older independent orchestrator that resolved no
  // policy at all (see {@link TrustPolicyView}). Calling that `(defaults)` would
  // be wrong twice over: nothing is stored AND no defaults are being applied.
  const noSource = policy.forkPolicy === undefined ? 'none (no policy stored)' : 'none (defaults)';
  const provenance = policy.platformManaged
    ? `${policy.source ?? 'platform'} (managed by the KiCI Platform)`
    : (policy.source ?? noSource);
  rows.push(['Source', provenance], ['Updated', policy.updatedAt ?? 'never']);

  const warnings = forkDropWarnings(policy);
  return warnings.length ? `${renderRows(rows)}\n\n${warnings.join('\n\n')}` : renderRows(rows);
}

/**
 * Warn that the fork switch in force silently drops pull requests.
 *
 * `ignore` is the one verdict that leaves nothing behind: no run row, no check
 * status, and nothing on the pull request itself. A maintainer who does not
 * already know the switch exists has no way to connect a fork PR that CI never
 * touched to a policy they never set, so the reader of `trust-policy show`
 * is told outright — with where to look for each individual drop.
 *
 * Returns the lines rather than printing them so the check is unit-testable,
 * matching `policyExpiryWarnings` below.
 */
export function forkDropWarnings(policy: TrustPolicyView): string[] {
  if (policy.forkPolicy !== ForkPolicy.enum.ignore) return [];

  const lines = [
    'Warning: this policy drops fork pull requests before dispatch. KiCI creates no run, ' +
      'posts no check, and the contributor sees nothing on the pull request.\n' +
      '         Each drop increments kici_orch_fork_events_ignored_total, and the ' +
      "delivery's event-log row records the reason (kici-admin event-log show " +
      '<delivery-id>; the list table omits it).',
  ];

  if (policy.effectiveDefault) {
    // The Platform owns the policy wherever one is attached, so the operator
    // cannot set it here — pointing them at `trust-policy set` would name a
    // verb the route answers with a 409.
    const remedy = policy.platformManaged
      ? 'Set one under Settings > CI trust in the dashboard.'
      : `Set one with: kici-admin trust-policy set --customer-id ${policy.customerId} ` +
        `--fork-policy ${ForkPolicy.enum.hold}`;
    lines.push(
      `Warning: no policy is stored for this org, so the drop above is a default nobody ` +
        `chose.\n         ${remedy}`,
    );
  }

  return lines;
}

/**
 * Render the enforced hold window.
 *
 * A whole number of hours still prints as `72 h`, exactly as it always did, so
 * no existing policy's output moves. Anything finer prints in seconds, because
 * the hours spelling cannot express it and rounding would report a window the
 * orchestrator is not applying.
 *
 * A policy carrying neither field is an orchestrator old enough to have
 * resolved no policy at all (see {@link TrustPolicyView}); one carrying only
 * hours is an orchestrator that predates the seconds window.
 */
export function formatExpiry(policy: TrustPolicyView): string {
  const seconds =
    policy.approvalExpirySeconds ??
    (policy.approvalExpiryHours === undefined
      ? undefined
      : policy.approvalExpiryHours * SECONDS_PER_HOUR);
  if (seconds === undefined) return 'unknown';
  return seconds % SECONDS_PER_HOUR === 0 ? `${seconds / SECONDS_PER_HOUR} h` : `${seconds} s`;
}

/** Align a label/value list into the `label:<pad> value` shape both verbs print. */
function renderRows(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${(label + ':').padEnd(width)} ${value}`).join('\n');
}

/**
 * Turn CLI flags into a PATCH body, exiting on an unknown value.
 *
 * Validating here as well as on the route is deliberate: it turns a typo into a
 * clear local message naming the accepted values instead of a 400 from the API.
 */
export function buildPolicyPatch(
  opts: Record<string, string | undefined>,
): Record<string, string | number> {
  const patch: Record<string, string | number> = {};

  const forkPolicy = opts[FORK_POLICY_KNOB.field];
  if (forkPolicy !== undefined) {
    if (!(FORK_POLICY_KNOB.values as readonly string[]).includes(forkPolicy)) {
      console.error(
        `Error: --${FORK_POLICY_KNOB.flag} must be one of: ${FORK_POLICY_KNOB.values.join(' | ')}`,
      );
      process.exit(1);
    }
    patch[FORK_POLICY_KNOB.field] = forkPolicy;
  }

  for (const [field, flag, min] of EXPIRY_FLAGS) {
    const raw = opts[field];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      console.error(`Error: --${flag} must be an integer >= ${min}`);
      process.exit(1);
    }
    patch[field] = n;
  }

  return patch;
}

/** The two spellings of one window: patch field, CLI flag, and its floor. */
const EXPIRY_FLAGS = [
  ['approvalExpiryHours', 'approval-expiry-hours', 1],
  ['approvalExpirySeconds', 'approval-expiry-seconds', MIN_APPROVAL_EXPIRY_SECONDS],
] as const;

/**
 * Warn when a patch names both spellings of the hold window.
 *
 * The route resolves this deterministically — the more specific seconds value
 * wins — but an operator who passed both asked for two different things, so the
 * one that is not applied is named rather than dropped in silence.
 *
 * Returns the lines rather than printing them so the check is unit-testable,
 * matching `forkDropWarnings` above.
 */
export function policyExpiryWarnings(patch: Record<string, string | number>): string[] {
  if (patch.approvalExpiryHours === undefined || patch.approvalExpirySeconds === undefined) {
    return [];
  }
  return [
    `Warning: --approval-expiry-hours ${patch.approvalExpiryHours} is ignored because ` +
      `--approval-expiry-seconds ${patch.approvalExpirySeconds} was also given; the more ` +
      `specific value wins.`,
  ];
}

/** One identity link as the directory route reports it. */
interface DirectoryIdentityLink {
  userId: string;
  provider: string;
  providerUsername: string;
  providerUserId?: string | null;
}

/** One operator-defined team as the directory route reports it. */
interface DirectoryTeam {
  teamName: string;
  memberUserIds: string[];
}

/** The cached approval directory as the admin route returns it. */
export interface TrustDirectoryView {
  customerId: string;
  identityLinks: DirectoryIdentityLink[];
  memberCiTrustLevels: Record<string, string>;
  teamMemberships: DirectoryTeam[];
  updatedAt: string;
}

interface DirectoryResponse {
  directory: TrustDirectoryView | null;
  platformManaged: boolean;
  /**
   * Whether the orchestrator's Platform connection is up right now.
   *
   * Absent whenever there is no connection state to report, which never means
   * "down": an independent orchestrator, the `PATCH` and `DELETE` responses,
   * and an orchestrator that predates the field. {@link directoryStalenessNote}
   * escalates only on an explicit `false`.
   */
  platformConnected?: boolean;
  /** Present on `directory-remove`: false when the member held nothing. */
  removed?: boolean;
}

/**
 * Say how long ago the directory was written, beside the timestamp itself.
 *
 * The absolute time is what the orchestrator stored and stays first, because it
 * is what correlates with a Platform-side change. The age is what an operator
 * would otherwise compute in their head at the exact moment they are least able
 * to — mid-incident, reading a refused approval.
 *
 * A timestamp this cannot parse renders alone rather than as `NaN`, and one in
 * the future renders as `0s` — the two clocks are different machines'.
 */
export function formatDirectoryAge(updatedAt: string, now: number): string {
  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return updatedAt;
  return `${updatedAt} (${formatUptime(Math.max(0, Math.round((now - written) / 1000)))} ago)`;
}

/**
 * Explain what an old directory costs, and escalate when it cannot refresh.
 *
 * Only a Platform-attached orchestrator has an upstream to lag behind. An
 * independent one's directory is written by the operator reading this, so there
 * is nothing to be stale against and nothing to say.
 *
 * The connected wording is a `Note:` and the disconnected one a `Warning:`,
 * because the two ask for different things: one states a property of the design
 * the reader should know, the other names a condition they should act on. The
 * `Warning:` producers above — `forkDropWarnings` and `policyExpiryWarnings` —
 * are both of the second kind.
 *
 * Returns the lines rather than printing them so the check is unit-testable,
 * matching `forkDropWarnings` above.
 */
export function directoryStalenessNote(res: DirectoryResponse): string[] {
  if (!res.platformManaged || res.directory === null) return [];

  if (res.platformConnected === false) {
    return [
      'Warning: the Platform connection is down, so no push can arrive and this directory\n' +
        '         cannot refresh. A `/kici approve` comment is authorized against this\n' +
        "         cached directory, not against the Platform's live membership, so a member\n" +
        '         whose CI trust the Platform revoked keeps it here for as long as the\n' +
        '         connection stays down. That window is unbounded.\n' +
        '         The directory is deliberately never expired: refusing every approval\n' +
        '         during an outage is the worse failure.',
    ];
  }

  return [
    'Note: a `/kici approve` comment is authorized against this cached directory, not\n' +
      "      against the Platform's live membership. A membership or CI-trust change made\n" +
      "      on the Platform after the time above reaches this orchestrator on the Platform's\n" +
      '      next push.\n' +
      '      Watch kici_orch_trust_directory_age_seconds to see how far behind it is.',
  ];
}

/**
 * Render the stored approval directory, or say why there is nothing to render.
 *
 * The directory is what `/kici approve` is resolved against: a commenter is
 * matched to a KiCI user through the identity links, that user's CI trust level
 * decides whether the approval counts, and a `{team}` clause is matched against
 * the team memberships. So the listing is per-entry rather than a set of counts
 * — "who can approve right now" is the question this command exists to answer.
 *
 * `now` is a parameter so the rendered age is deterministic under test; every
 * caller takes the default.
 */
export function formatDirectory(
  res: DirectoryResponse,
  format: string,
  now: number = Date.now(),
): string {
  if (format === 'json') return JSON.stringify(res, null, 2);

  const owner = res.platformManaged
    ? 'the KiCI Platform (read-only here)'
    : "this orchestrator's operator, via `kici-admin trust-policy directory-set`";

  if (res.directory === null) {
    // Two different absences with two different remedies, so they get two
    // different sentences: a Platform-attached orchestrator waits for a push it
    // cannot make happen, while an independent one is waiting for the operator.
    const remedy = res.platformManaged
      ? 'A Platform-attached orchestrator receives the directory on the push that follows ' +
        'its next successful control-plane handshake.'
      : 'No Platform is attached, so nothing will ever be pushed here — register approvers ' +
        'with `kici-admin trust-policy directory-set`.';
    return (
      `No approval directory is stored.\n` +
      `Written by: ${owner}\n\n` +
      `Until one is stored, a \`/kici approve\` comment cannot be attributed to a KiCI user ` +
      `and is refused. ${remedy}`
    );
  }

  const dir = res.directory;
  const lines = [
    renderRows([
      ['Stored at', formatDirectoryAge(dir.updatedAt, now)],
      ['Written by', owner],
      ['Identity links', String(dir.identityLinks.length)],
      ['Members with CI trust', String(Object.keys(dir.memberCiTrustLevels).length)],
      ['Teams', String(dir.teamMemberships.length)],
    ]),
  ];

  if (dir.identityLinks.length > 0) {
    lines.push(
      '',
      'Identity links:',
      ...dir.identityLinks.map(
        (l) =>
          `  ${l.provider}:${l.providerUsername} -> ${l.userId} (id ${l.providerUserId ?? '-'})`,
      ),
    );
  }

  const trustEntries = Object.entries(dir.memberCiTrustLevels);
  if (trustEntries.length > 0) {
    lines.push('', 'Member CI trust:', ...trustEntries.map(([id, level]) => `  ${id} -> ${level}`));
  }

  if (dir.teamMemberships.length > 0) {
    lines.push(
      '',
      'Teams:',
      ...dir.teamMemberships.map((t) => `  ${t.teamName} (${t.memberUserIds.length} member(s))`),
    );
  }

  const note = directoryStalenessNote(res);
  if (note.length > 0) lines.push('', ...note);

  return lines.join('\n');
}

export function registerTrustPolicyCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const tp = program
    .command('trust-policy')
    .description(
      'Show or set the org trust policy the orchestrator enforces, and read the cached ' +
        'approval directory it arrives with',
    );

  tp.command('show')
    .description('Print the trust policy currently enforced for an org')
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId: string; format: string }) => {
      try {
        const res = await getClient().get<PolicyResponse>(
          `/api/v1/admin/trust-policy?customerId=${encodeURIComponent(opts.customerId)}`,
        );
        console.log(formatPolicy(res.policy, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // The reader, available in every mode. Its writers are the two siblings
  // below, which refuse wherever a Platform is attached.
  tp.command('directory')
    .description(
      'Print the stored approval directory — identity links, member CI trust levels, and ' +
        'teams',
    )
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId: string; format: string }) => {
      try {
        const res = await getClient().get<DirectoryResponse>(
          `/api/v1/admin/trust-policy/directory?customerId=${encodeURIComponent(opts.customerId)}`,
        );
        console.log(formatDirectory(res, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tp.command('directory-set')
    .description(
      'Register a member as an approver: link their provider account to a KiCI user id and ' +
        'set their CI trust level (independent orchestrators only — a Platform-attached ' +
        'orchestrator is managed from the dashboard)',
    )
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .requiredOption('--user-id <id>', 'KiCI user id the approval is attributed to')
    .requiredOption('--provider-username <name>', 'Provider-side username (display only)')
    .requiredOption(
      '--provider-user-id <id>',
      "Immutable provider-side numeric id (GitHub's `sender.id`). Required: an approval " +
        'comment is matched on this alone, never on the username',
    )
    .requiredOption(
      '--ci-trust <level>',
      `CI trust level to grant (${CiTrustLevel.options.join(' | ')}); write or admin may approve`,
    )
    .option('--provider <name>', 'Provider the link is for', 'github')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: Record<string, string>) => {
      // Validated here as well as on the route, so a typo becomes a local
      // message naming the accepted values instead of a 400 from the API —
      // matching how `buildPolicyPatch` handles the policy flags.
      if (!CiTrustLevel.options.includes(opts.ciTrust as never)) {
        console.error(`Error: --ci-trust must be one of: ${CiTrustLevel.options.join(' | ')}`);
        process.exit(1);
      }
      try {
        const res = await getClient().patch<DirectoryResponse>(
          '/api/v1/admin/trust-policy/directory',
          {
            customerId: opts.customerId,
            userId: opts.userId,
            provider: opts.provider,
            providerUsername: opts.providerUsername,
            providerUserId: opts.providerUserId,
            ciTrust: opts.ciTrust,
          },
        );
        console.log(formatDirectory(res, opts.format ?? 'table'));
      } catch (err) {
        // Includes the route's 409 "managed by the KiCI Platform" message,
        // surfaced verbatim.
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tp.command('directory-remove')
    .description(
      'Revoke a member: remove every identity link they hold and their CI trust level ' +
        '(independent orchestrators only)',
    )
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .requiredOption('--user-id <id>', 'KiCI user id to revoke')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId: string; userId: string; format?: string }) => {
      try {
        const res = await getClient().delete<DirectoryResponse>(
          `/api/v1/admin/trust-policy/directory?customerId=${encodeURIComponent(opts.customerId)}` +
            `&userId=${encodeURIComponent(opts.userId)}`,
        );
        const format = opts.format ?? 'table';
        // Said before the listing, and only in table mode — `--format json`
        // already carries `removed` in the body it prints verbatim.
        if (format !== 'json' && res.removed === false) {
          console.log(`${opts.userId} held no identity link and no CI trust level; nothing to do.`);
        }
        console.log(formatDirectory(res, format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  const setCmd = tp
    .command('set')
    .description(
      'Set the trust policy (independent orchestrators only — a Platform-attached ' +
        'orchestrator is managed from the dashboard). At least one flag required.',
    )
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .option('--format <format>', 'Output format: json|table', 'table');
  setCmd.option(
    `--${FORK_POLICY_KNOB.flag} <value>`,
    `${FORK_POLICY_KNOB.label} (${FORK_POLICY_KNOB.values.join(' | ')})`,
  );
  setCmd.option(
    '--approval-expiry-hours <value>',
    'Security-hold approval expiry, in hours (integer >= 1)',
  );
  setCmd.option(
    '--approval-expiry-seconds <value>',
    `Security-hold approval expiry, in seconds (integer >= ${MIN_APPROVAL_EXPIRY_SECONDS}). ` +
      'Wins over --approval-expiry-hours when both are given.',
  );

  setCmd.action(async (opts: Record<string, string | undefined>) => {
    const patch = buildPolicyPatch(opts);
    if (Object.keys(patch).length === 0) {
      console.error('Error: at least one policy flag is required');
      process.exit(1);
    }
    for (const line of policyExpiryWarnings(patch)) {
      console.warn(line);
    }
    try {
      const res = await getClient().patch<PolicyResponse>('/api/v1/admin/trust-policy', {
        customerId: opts.customerId,
        ...patch,
      });
      console.log(formatPolicy(res.policy, opts.format ?? 'table'));
    } catch (err) {
      // Includes the route's 409 "managed by the KiCI Platform" message,
      // surfaced verbatim.
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  });
}
