/**
 * `kici-admin trust-policy` commands, against the orchestrator admin API
 * (`routes/admin-trust-policy.ts`) so they work while the Platform is down.
 *
 * `show` and `directory` read in every mode. The writers work only on an
 * independent orchestrator: an attached Platform owns the policy and the
 * directory, and the route's 409 message is surfaced verbatim so the CLI
 * cannot drift from the server.
 *
 * The directory writers share this namespace because they are the same
 * org-trust concept under the same mode rule and route file. They are siblings
 * of `directory`, not subcommands: turning that leaf into a group would break
 * `kici-admin trust-policy directory` for existing users.
 */
import type { Command } from 'commander';
import { formatUptime, toErrorMessage } from '@kici-dev/shared';
import {
  CiTrustLevel,
  ForkPolicy,
  formatExpiryDuration,
  parseExpiryDuration,
} from '@kici-dev/engine';
import type { AdminApiClient } from '../api-client.js';
import { cliAction } from './shared/cli-action.js';

/**
 * The policy fields are optional because a v0.5.0 independent orchestrator with
 * no policy row omits them (a v0.5.0 Platform-attached one still sent the
 * fail-closed values). This build always sends them, so the `unknown` fallbacks
 * and `no policy stored` wording render only against that older orchestrator.
 */
export interface TrustPolicyView {
  customerId: string;
  forkPolicy?: string;
  /** The hold window, in seconds. */
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
 * The values are the wire enum itself, so every value the gate honours is
 * settable, including `ignore`, which an orchestrator with no stored row applies.
 */
const FORK_POLICY_KNOB = {
  field: 'forkPolicy',
  flag: 'fork-policy',
  label: 'Fork PR policy',
  values: ForkPolicy.options,
} as const;

export function formatPolicy(policy: TrustPolicyView, format: string): string {
  if (format === 'json') return JSON.stringify(policy, null, 2);

  const rows: Array<[string, string]> = [
    ['Fork PR policy', policy.forkPolicy ?? 'unknown'],
    ['Approval expiry', formatExpiry(policy)],
  ];

  // Absent fields mean an older orchestrator that resolved no policy (see
  // {@link TrustPolicyView}): nothing is stored and no defaults apply.
  const noSource = policy.forkPolicy === undefined ? 'none (no policy stored)' : 'none (defaults)';
  const provenance = policy.platformManaged
    ? `${policy.source ?? 'platform'} (managed by the KiCI Platform)`
    : (policy.source ?? noSource);
  rows.push(['Source', provenance], ['Updated', policy.updatedAt ?? 'never']);

  const warnings = forkDropWarnings(policy);
  return warnings.length ? `${renderRows(rows)}\n\n${warnings.join('\n\n')}` : renderRows(rows);
}

/**
 * Warn that the fork switch in force silently drops pull requests. `ignore`
 * leaves no run row, no check and nothing on the PR, so a maintainer cannot
 * otherwise connect an untouched fork PR to a policy they never set. Returns the
 * lines rather than printing them, so the check is unit-testable.
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
    // An attached Platform owns the policy: `trust-policy set` would get a 409.
    const remedy = policy.platformManaged
      ? 'Set one under Settings > CI trust in the dashboard.'
      : `Set one with: kici-admin trust-policy set --org ${policy.customerId} ` +
        `--fork-policy ${ForkPolicy.enum.hold}`;
    lines.push(
      `Warning: no policy is stored for this org, so the drop above is a default nobody ` +
        `chose.\n         ${remedy}`,
    );
  }

  return lines;
}

/**
 * In the `--approval-expiry` spelling (`72h`, `1h30m`); see {@link TrustPolicyView}
 * for `unknown`.
 */
export function formatExpiry(policy: TrustPolicyView): string {
  return policy.approvalExpirySeconds === undefined
    ? 'unknown'
    : formatExpiryDuration(policy.approvalExpirySeconds);
}

/** Align a label/value list into the `label:<pad> value` shape both verbs print. */
function renderRows(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${(label + ':').padEnd(width)} ${value}`).join('\n');
}

/**
 * Turn CLI flags into a PATCH body, exiting on an unknown value. It validates
 * as well as the route so a typo names the accepted values instead of a 400.
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

  if (opts.approvalExpiry !== undefined) {
    try {
      patch.approvalExpirySeconds = parseExpiryDuration(opts.approvalExpiry);
    } catch (err) {
      console.error(`Error: --approval-expiry: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  }

  return patch;
}

interface DirectoryIdentityLink {
  userId: string;
  provider: string;
  providerUsername: string;
  providerUserId?: string | null;
}

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
   * Absent never means "down" (independent orchestrator, `PATCH`/`DELETE`
   * responses, older orchestrator); {@link directoryStalenessNote} escalates
   * only on an explicit `false`.
   */
  platformConnected?: boolean;
  /** Present on `directory-remove`: false when the member held nothing. */
  removed?: boolean;
}

/**
 * The stored timestamp stays first, since it correlates with Platform-side
 * changes; the age saves the operator the math mid-incident. An unparsable
 * timestamp renders alone, and a future one as `0s` (different machines' clocks).
 */
export function formatDirectoryAge(updatedAt: string, now: number): string {
  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return updatedAt;
  return `${updatedAt} (${formatUptime(Math.max(0, Math.round((now - written) / 1000)))} ago)`;
}

/**
 * Explain what an old directory costs, escalating when it cannot refresh. Only
 * a Platform-attached orchestrator has an upstream to lag behind. Connected is a
 * `Note:` (a design property); disconnected is a `Warning:` (act on it). Returns
 * the lines, matching `forkDropWarnings`, so the check is unit-testable.
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
 * `/kici approve` resolves against this directory (identity links → user, CI
 * trust level → counts or not, teams → `{team}` clauses), so it lists per entry:
 * the command answers "who can approve right now". `now` exists for tests.
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
    // Attached waits for a Platform push; independent waits for the operator.
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
    .requiredOption('--org <id>', 'Org id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (opts: { org: string; format: string }) => {
        const res = await getClient().get<PolicyResponse>(
          `/api/v1/admin/trust-policy?customerId=${encodeURIComponent(opts.org)}`,
        );
        console.log(formatPolicy(res.policy, opts.format));
      }),
    );

  // Reads in every mode; its writer siblings refuse wherever a Platform is attached.
  tp.command('directory')
    .description(
      'Print the stored approval directory — identity links, member CI trust levels, and ' +
        'teams',
    )
    .requiredOption('--org <id>', 'Org id')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (opts: { org: string; format: string }) => {
        const res = await getClient().get<DirectoryResponse>(
          `/api/v1/admin/trust-policy/directory?customerId=${encodeURIComponent(opts.org)}`,
        );
        console.log(formatDirectory(res, opts.format));
      }),
    );

  tp.command('directory-set')
    .description(
      'Register a member as an approver: link their provider account to a KiCI user id and ' +
        'set their CI trust level (independent orchestrators only — a Platform-attached ' +
        'orchestrator is managed from the dashboard)',
    )
    .requiredOption('--org <id>', 'Org id')
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
      // Validated locally too, as in `buildPolicyPatch`.
      if (!CiTrustLevel.options.includes(opts.ciTrust as never)) {
        console.error(`Error: --ci-trust must be one of: ${CiTrustLevel.options.join(' | ')}`);
        process.exit(1);
      }
      try {
        const res = await getClient().patch<DirectoryResponse>(
          '/api/v1/admin/trust-policy/directory',
          {
            customerId: opts.org,
            userId: opts.userId,
            provider: opts.provider,
            providerUsername: opts.providerUsername,
            providerUserId: opts.providerUserId,
            ciTrust: opts.ciTrust,
          },
        );
        console.log(formatDirectory(res, opts.format ?? 'table'));
      } catch (err) {
        // Surfaces the route's 409 message verbatim.
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tp.command('directory-remove')
    .description(
      'Revoke a member: remove every identity link they hold and their CI trust level ' +
        '(independent orchestrators only)',
    )
    .requiredOption('--org <id>', 'Org id')
    .requiredOption('--user-id <id>', 'KiCI user id to revoke')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(
      cliAction(async (opts: { org: string; userId: string; format?: string }) => {
        const res = await getClient().delete<DirectoryResponse>(
          `/api/v1/admin/trust-policy/directory?customerId=${encodeURIComponent(opts.org)}` +
            `&userId=${encodeURIComponent(opts.userId)}`,
        );
        const format = opts.format ?? 'table';
        // Table mode only: `--format json` already carries `removed`.
        if (format !== 'json' && res.removed === false) {
          console.log(`${opts.userId} held no identity link and no CI trust level; nothing to do.`);
        }
        console.log(formatDirectory(res, format));
      }),
    );

  const setCmd = tp
    .command('set')
    .description(
      'Set the trust policy (independent orchestrators only — a Platform-attached ' +
        'orchestrator is managed from the dashboard). At least one flag required.',
    )
    .requiredOption('--org <id>', 'Org id')
    .option('--format <format>', 'Output format: json|table', 'table');
  setCmd.option(
    `--${FORK_POLICY_KNOB.flag} <value>`,
    `${FORK_POLICY_KNOB.label} (${FORK_POLICY_KNOB.values.join(' | ')})`,
  );
  setCmd.option(
    '--approval-expiry <duration>',
    'Security-hold approval expiry, e.g. 72h, 30m or 1h30m',
  );

  setCmd.action(async (opts: Record<string, string | undefined>) => {
    const patch = buildPolicyPatch(opts);
    if (Object.keys(patch).length === 0) {
      console.error('Error: at least one policy flag is required');
      process.exit(1);
    }
    try {
      const res = await getClient().patch<PolicyResponse>('/api/v1/admin/trust-policy', {
        customerId: opts.org,
        ...patch,
      });
      console.log(formatPolicy(res.policy, opts.format ?? 'table'));
    } catch (err) {
      // Surfaces the route's 409 message verbatim.
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  });
}
