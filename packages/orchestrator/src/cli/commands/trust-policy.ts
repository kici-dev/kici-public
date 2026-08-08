/**
 * Org trust-policy commands for kici-admin.
 *
 * Subcommand namespace: `kici-admin trust-policy <show|set>`.
 *
 * Talks to the orchestrator admin API directly (not the Platform dashboard
 * proxy), so the CLI stays operable even when Platform is unavailable. Backed
 * by `packages/orchestrator/src/routes/admin-trust-policy.ts`.
 *
 * `set` only works on an independent orchestrator. Wherever a Platform is
 * attached the Platform owns the policy and the route refuses with 409; the
 * message is surfaced verbatim rather than reworded here, so the CLI cannot
 * drift from what the server actually said.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { TrustPolicyEnforcement } from '../../security/trust-policy-gate.js';
import type { AdminApiClient } from '../api-client.js';

/**
 * The policy shape the admin route returns.
 *
 * The four policy fields are OPTIONAL because the route omits them under
 * `enforcement: 'legacy'` — there they would be values nothing enforces, and
 * printing them is the false assurance this feature exists to remove.
 */
export interface TrustPolicyView {
  customerId: string;
  forkPolicy?: string;
  unknownContributorPolicy?: string;
  workflowChangePolicy?: string;
  approvalExpiryHours?: number;
  /** `policy` = the values below are enforced; `legacy` = only the legacy rule. */
  enforcement?: TrustPolicyEnforcement;
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
}

const KNOBS: readonly PolicyKnob[] = [
  {
    field: 'forkPolicy',
    flag: 'fork-policy',
    label: 'Fork PR policy',
    values: ['hold', 'reject', 'allow'],
  },
  {
    field: 'unknownContributorPolicy',
    flag: 'unknown-contributor-policy',
    label: 'Unknown contributor policy',
    // No `allow`: the wire enum has no such member, so it is not offered here.
    values: ['hold', 'reject'],
  },
  {
    field: 'workflowChangePolicy',
    flag: 'workflow-change-policy',
    label: 'Workflow change policy',
    values: ['hold', 'reject', 'allow'],
  },
];

/** Render the policy as an aligned table, or as JSON when asked. */
export function formatPolicy(policy: TrustPolicyView, format: string): string {
  if (format === 'json') return JSON.stringify(policy, null, 2);

  const legacy = policy.enforcement === TrustPolicyEnforcement.enum.legacy;
  const rows: Array<[string, string]> = [];
  // In legacy mode the route sends no policy fields, so there is nothing to
  // render for them — printing `hold` would claim an enforcement that is not
  // happening. The Enforcement row below says so explicitly instead.
  if (!legacy) {
    rows.push(
      ['Fork PR policy', policy.forkPolicy ?? 'unknown'],
      ['Unknown contributor policy', policy.unknownContributorPolicy ?? 'unknown'],
      ['Workflow change policy', policy.workflowChangePolicy ?? 'unknown'],
      [
        'Approval expiry',
        policy.approvalExpiryHours === undefined ? 'unknown' : `${policy.approvalExpiryHours} h`,
      ],
    );
  }

  // `none (defaults)` would contradict the Enforcement row in legacy mode: no
  // policy is stored AND no defaults are applied there, so say only the first.
  const noSource = legacy ? 'none (no policy stored)' : 'none (defaults)';
  const provenance = policy.platformManaged
    ? `${policy.source ?? 'platform'} (managed by the KiCI Platform)`
    : (policy.source ?? noSource);
  rows.push(['Source', provenance]);
  if (legacy) {
    rows.push([
      'Enforcement',
      'legacy — no policy stored; only workflow changes by a non-trusted contributor hold',
    ]);
  }
  rows.push(['Updated', policy.updatedAt ?? 'never']);

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

  const expiry = opts.approvalExpiryHours;
  if (expiry !== undefined) {
    const n = Number(expiry);
    if (!Number.isInteger(n) || n < 1) {
      console.error('Error: --approval-expiry-hours must be an integer >= 1');
      process.exit(1);
    }
    patch.approvalExpiryHours = n;
  }

  return patch;
}

/** `fork-policy` → `forkPolicy`, matching how commander stores long options. */
function camelFromFlag(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function registerTrustPolicyCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const tp = program
    .command('trust-policy')
    .description('Show or set the org trust policy the orchestrator enforces');

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

  const setCmd = tp
    .command('set')
    .description(
      'Set the trust policy (independent orchestrators only — a Platform-attached ' +
        'orchestrator is managed from the dashboard). At least one flag required.',
    )
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .option('--format <format>', 'Output format: json|table', 'table');
  for (const knob of KNOBS) {
    setCmd.option(`--${knob.flag} <value>`, `${knob.label} (${knob.values.join(' | ')})`);
  }
  setCmd.option('--approval-expiry-hours <value>', 'Security-hold approval expiry (integer >= 1)');

  setCmd.action(async (opts: Record<string, string | undefined>) => {
    const patch = buildPolicyPatch(opts);
    if (Object.keys(patch).length === 0) {
      console.error('Error: at least one policy flag is required');
      process.exit(1);
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
