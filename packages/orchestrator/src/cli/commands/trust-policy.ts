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
import { toErrorMessage } from '@kici-dev/shared';
import {
  CiTrustLevel,
  ForkPolicy,
  MIN_APPROVAL_EXPIRY_SECONDS,
  SECONDS_PER_HOUR,
  trustPolicySchema,
} from '@kici-dev/engine';
import type { AdminApiClient } from '../api-client.js';

/**
 * The policy shape the admin route returns.
 *
 * The four policy fields are OPTIONAL because a **v0.5.0 independent**
 * orchestrator omits them: there, and only there, no policy row and no attached
 * Platform meant no policy was resolved at all, and it reported
 * `enforcement: 'legacy'` with the fields absent. A v0.5.0 Platform-attached
 * orchestrator with no row still sent the fail-closed values. This build's route
 * always sends them in every mode, so the `unknown` fallbacks below — and the
 * `no policy stored` provenance wording — render only against that older
 * independent orchestrator.
 *
 * The route also sends a deprecated `enforcement` field. Nothing here reads it —
 * on this build it is always `policy` — so it is absent from this shape;
 * `--format json` stringifies the parsed policy object, so the field still
 * reaches the operator verbatim.
 */
export interface TrustPolicyView {
  customerId: string;
  forkPolicy?: string;
  unknownContributorPolicy?: string;
  workflowChangePolicy?: string;
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

/** One settable knob: wire field, CLI flag, accepted values, and label. */
interface PolicyKnob {
  field: 'forkPolicy' | 'unknownContributorPolicy' | 'workflowChangePolicy';
  flag: string;
  label: string;
  values: readonly string[];
  /**
   * Set when the flag is accepted only for compatibility. Its presence turns
   * the flag into a warning at `set` time and annotates its help text.
   */
  deprecated?: string;
}

/** What a deprecated arm's warning says, and what its help text is suffixed with. */
const DEAD_ARM_NOTE = 'deprecated: no longer enforced; removed at v1.0.0';

const KNOBS: readonly PolicyKnob[] = [
  {
    field: 'forkPolicy',
    flag: 'fork-policy',
    label: 'Fork PR policy',
    // The wire enum itself, so every value the gate honours is settable —
    // including `ignore`, which is what an orchestrator with no stored row
    // already applies and therefore has to be expressible.
    values: ForkPolicy.options,
  },
  {
    field: 'unknownContributorPolicy',
    flag: 'unknown-contributor-policy',
    label: 'Unknown contributor policy',
    // Taken from the wire schema, so the CLI can never offer a value the route
    // refuses. That schema declares no `allow` member for this arm.
    values: trustPolicySchema.shape.unknownContributorPolicy.options,
    deprecated: DEAD_ARM_NOTE,
  },
  {
    field: 'workflowChangePolicy',
    flag: 'workflow-change-policy',
    label: 'Workflow change policy',
    values: trustPolicySchema.shape.workflowChangePolicy.options,
    deprecated: DEAD_ARM_NOTE,
  },
];

/**
 * Render the policy as an aligned table, or as JSON when asked.
 *
 * The two deprecated arms are deliberately absent from the table: no dispatch
 * decision reads either one, so a row claiming `Unknown contributor policy:
 * hold` would assert an enforcement that is not happening. They are still
 * stored and still echoed back, and `--format json` prints the policy object the
 * route returned, so the values remain reachable for anyone who needs them.
 */
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

  return renderRows(rows);
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

  for (const knob of KNOBS) {
    const raw = opts[camelFromFlag(knob.flag)];
    if (raw === undefined) continue;
    if (!knob.values.includes(raw)) {
      console.error(`Error: --${knob.flag} must be one of: ${knob.values.join(' | ')}`);
      process.exit(1);
    }
    patch[knob.field] = raw;
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
 * matching `policyDeprecationWarnings` below.
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

/**
 * Warn about deprecated flags and deprecated values in an already-built patch.
 *
 * Every one of these still PATCHes through unchanged — the orchestrator stores
 * what it is given, and an older Platform or CLI keeps seeing the value it
 * expects. The warning says what the value does now, which for all three is
 * nothing the fork switch reads.
 *
 * Returns the lines rather than printing them so the check is unit-testable,
 * matching `unpairedEvalTimeoutWarnings` in `cluster-settings.ts`.
 */
export function policyDeprecationWarnings(patch: Record<string, string | number>): string[] {
  const warnings: string[] = [];

  if (patch.forkPolicy === ForkPolicy.enum.reject) {
    warnings.push(
      `Warning: --fork-policy ${ForkPolicy.enum.reject} is deprecated in favour of ` +
        `--fork-policy ${ForkPolicy.enum.ignore}, which it already behaves as; removed at ` +
        `v1.0.0. The value is stored as given.`,
    );
  }

  for (const knob of KNOBS) {
    if (knob.deprecated === undefined) continue;
    if (patch[knob.field] === undefined) continue;
    warnings.push(
      `Warning: --${knob.flag} is ${knob.deprecated}. The value is stored and echoed back, ` +
        `but no dispatch decision reads it.`,
    );
  }

  return warnings;
}

/** `fork-policy` → `forkPolicy`, matching how commander stores long options. */
function camelFromFlag(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
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
  /** Present on `directory-remove`: false when the member held nothing. */
  removed?: boolean;
}

/**
 * Render the stored approval directory, or say why there is nothing to render.
 *
 * The directory is what `/kici approve` is resolved against: a commenter is
 * matched to a KiCI user through the identity links, that user's CI trust level
 * decides whether the approval counts, and a `{team}` clause is matched against
 * the team memberships. So the listing is per-entry rather than a set of counts
 * — "who can approve right now" is the question this command exists to answer.
 */
export function formatDirectory(res: DirectoryResponse, format: string): string {
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
      ['Stored at', dir.updatedAt],
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
  for (const knob of KNOBS) {
    const suffix = knob.deprecated === undefined ? '' : ` [${knob.deprecated}]`;
    setCmd.option(`--${knob.flag} <value>`, `${knob.label} (${knob.values.join(' | ')})${suffix}`);
  }
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
    for (const line of [...policyDeprecationWarnings(patch), ...policyExpiryWarnings(patch)]) {
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
