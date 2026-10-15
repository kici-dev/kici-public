/**
 * The workflow install gate: the protection rules of every context a
 * workflow's `registries:` / `installEnv:` references name.
 *
 * Every context is evaluated before deciding, as on the job-level gate: any
 * reject rejects. Otherwise any hold raises ONE hold aggregating every context's
 * rules, most restrictive wins (`aggregateProtectionParams`: every held
 * context's reviewers approve, the longest wait timer applies), and records
 * which contexts held (covered by its approval) and which were admitted.
 *
 * The release gates again every context the approval did not cover, and
 * refuses when a recorded context now matches a different row.
 */
import { z } from 'zod';
import type { Context as EngineContext, ProtectionGateResult } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { Context as ContextRow } from '../db/types.js';
import { toContext } from '../contexts/context-store.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../contexts/protection/pipeline.js';
import {
  aggregateProtectionParams,
  buildEffectiveContext,
} from '../contexts/protection/aggregate.js';
import { InstallSecretsDecisionReason } from '../metrics/prometheus.js';

/** A context the install gate matched: the name the workflow used, and the row it matched. */
export const InstallGateContextSchema = z.object({ name: z.string(), id: z.string() });
export type InstallGateContext = z.infer<typeof InstallGateContextSchema>;

/** Stored with the held dispatch, so the release knows which contexts the approval covers. */
export const InstallGateRecordSchema = z.object({
  /** Contexts whose rules held. The hold's approval covers every one of them. */
  held: z.array(InstallGateContextSchema),
  /** Contexts whose rules passed when the hold was raised. The release gates them again. */
  admitted: z.array(InstallGateContextSchema),
});
export type InstallGateRecord = z.infer<typeof InstallGateRecordSchema>;

/** The reject reasons the install gate reports, as its decision metric labels them. */
export type InstallGateRejectReason =
  | typeof InstallSecretsDecisionReason.EnvNotFound
  | typeof InstallSecretsDecisionReason.ProtectionRuleBlock;

/** A gate verdict that holds the install. */
export type InstallGateHoldResult = ProtectionGateResult & { action: 'hold' | 'wait' | 'queue' };

export type InstallGateOutcome =
  | { kind: 'pass' }
  | { kind: 'reject'; reasonKind: InstallGateRejectReason; reason: string }
  | {
      kind: 'hold';
      /** The first held context in declaration order; it names the hold. */
      primary: InstallGateContext;
      result: InstallGateHoldResult;
      record: InstallGateRecord;
    };

interface GateInputs {
  /** Every referenced context name, in declaration order, with the row it matched. */
  matched: ReadonlyMap<string, ContextRow | null>;
  trustResolution: TrustResolution | undefined;
  protectionContext: JobDispatchContext;
}

interface Rejection {
  reasonKind: InstallGateRejectReason;
  reason: string;
}

/** The rejection for a referenced name no context matches. */
function notFound(envName: string): Rejection {
  return {
    reasonKind: InstallSecretsDecisionReason.EnvNotFound,
    reason: `registries: refers to context '${envName}' which does not exist`,
  };
}

/** Every rejection, named in declaration order; the first one labels the metric. */
function rejectAll(rejections: readonly Rejection[]): InstallGateOutcome {
  return {
    kind: 'reject',
    reasonKind: rejections[0].reasonKind,
    reason: rejections.map((r) => r.reason).join('; '),
  };
}

function isHold(result: ProtectionGateResult): result is InstallGateHoldResult {
  return result.action === 'hold' || result.action === 'wait' || result.action === 'queue';
}

/**
 * Run one context's protection rules for the workflow install. The context
 * name is the group and the running count is 0, so the concurrency gate never
 * holds an install; job-scope dispatch enforces concurrency limits.
 */
function evaluateInstallContext(
  envName: string,
  env: EngineContext,
  inputs: GateInputs,
): Promise<ProtectionGateResult> {
  return evaluateProtectionRules(
    env,
    inputs.protectionContext,
    0,
    envName,
    inputs.trustResolution?.tier,
  );
}

/**
 * The rejection a context's own verdict produces. On a release a hold verdict
 * reaches here too: a release never raises a second hold.
 */
function ruleRejection(envName: string, result: ProtectionGateResult): Rejection {
  if (result.action === 'reject') {
    return {
      reasonKind: InstallSecretsDecisionReason.ProtectionRuleBlock,
      reason: `context '${envName}' install gate reject: ${result.reason ?? 'rejected'}`,
    };
  }
  return {
    reasonKind: InstallSecretsDecisionReason.ProtectionRuleBlock,
    reason:
      `context '${envName}' install gate ${result.action} after the hold was released: ` +
      `${result.reason ?? result.action}; the approval did not cover this context`,
  };
}

/**
 * Evaluate every referenced context's rules and decide the install gate. Reject
 * wins over hold; a hold's aggregated requirement is at least as strict as each
 * held context's own.
 */
export async function gateInstall(inputs: GateInputs): Promise<InstallGateOutcome> {
  const rejections: Rejection[] = [];
  const held: Array<{
    ref: InstallGateContext;
    env: EngineContext;
    result: InstallGateHoldResult;
  }> = [];
  const admitted: InstallGateContext[] = [];
  const envs: EngineContext[] = [];
  for (const [envName, row] of inputs.matched) {
    if (!row) {
      rejections.push(notFound(envName));
      continue;
    }
    const env = toContext(row);
    envs.push(env);
    const result = await evaluateInstallContext(envName, env, inputs);
    const ref = { name: envName, id: env.id };
    if (result.action === 'pass') admitted.push(ref);
    else if (isHold(result)) held.push({ ref, env, result });
    else rejections.push(ruleRejection(envName, result));
  }
  // fails-when: a context that rejects is never evaluated because an earlier one held
  // breaks-if-wrong: a workflow whose contexts only hold must still be held, not rejected
  if (rejections.length > 0) return rejectAll(rejections);
  if (held.length === 0) return { kind: 'pass' };

  const primary = held[0];
  const effective = buildEffectiveContext(primary.env, aggregateProtectionParams(envs));
  const aggregate = await evaluateInstallContext(primary.ref.name, effective, inputs);
  return {
    kind: 'hold',
    primary: primary.ref,
    // The aggregate holds whenever one context does; the primary's verdict is a fallback.
    result: isHold(aggregate) ? aggregate : primary.result,
    record: { held: held.map((h) => h.ref), admitted },
  };
}

/**
 * Decide the install gate for a dispatch resumed from a released hold.
 *
 * Held contexts are covered by the approval and skip the gate: their reviewer
 * and wait-timer rules are stateless and would hold the approved run again.
 * Every other context is gated, and any verdict but pass rejects. A recorded
 * context must still match its recorded row.
 *
 * `releasedHold` is stored JSON: absent or malformed, it covers no context.
 */
export async function gateReleasedInstall(
  inputs: GateInputs & { releasedHold: unknown },
): Promise<InstallGateOutcome> {
  const parsed = InstallGateRecordSchema.safeParse(inputs.releasedHold);
  const record = parsed.success ? parsed.data : { held: [], admitted: [] };
  const covered = new Set(record.held.map((c) => c.name));
  const recordedIds = new Map([...record.held, ...record.admitted].map((c) => [c.name, c.id]));
  const rejections: Rejection[] = [];
  for (const [envName, row] of inputs.matched) {
    if (!row) {
      rejections.push(notFound(envName));
      continue;
    }
    const recordedId = recordedIds.get(envName);
    // fails-when: a context replaced while the hold waited resolves the new row's secrets
    // breaks-if-wrong: a context still matching the row recorded at hold time must resolve
    if (recordedId !== undefined && recordedId !== row.id) {
      rejections.push({
        reasonKind: InstallSecretsDecisionReason.EnvNotFound,
        reason: `context '${envName}' was removed or replaced while the install gate was held`,
      });
      continue;
    }
    // fails-when: a context the approval did not cover is delivered without its rules running
    // breaks-if-wrong: a context the approval covered must not be held again by its own rules
    if (covered.has(envName)) continue;
    const result = await evaluateInstallContext(envName, toContext(row), inputs);
    if (result.action !== 'pass') rejections.push(ruleRejection(envName, result));
  }
  return rejections.length > 0 ? rejectAll(rejections) : { kind: 'pass' };
}
