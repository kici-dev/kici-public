/**
 * Inputs every re-run path rebuilds from an original run: its stored webhook
 * payload, the provider binding its row records, the delivery's event name, the
 * normalized event, and its changed files. Shared by the per-repository re-run,
 * the evaluation-round re-run and release, and the cross-repository global
 * re-run, so the paths cannot disagree about how a run's inputs are read back.
 */
import type { SimulatedEvent } from '@kici-dev/engine';
import type { ProviderRegistry } from '../provider-registry.js';
import type { TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { WebhookInfo } from '../webhook/handler.js';
import { webhookPayloadPath } from './webhook-payload-store.js';
import { resolveEventChangedFiles, stampChangedFiles, withDefaultBranch } from './changed-files.js';
import type { OriginalRunRow, RerunDeps } from './rerun.js';

/**
 * Load the original webhook payload from object storage. Null for cron/schedule
 * runs (none stored) or an unparseable payload.
 */
export async function loadWebhookPayload(
  originalRunId: string,
  deps: Pick<RerunDeps, 'logStorage'>,
): Promise<Record<string, unknown> | null> {
  const payloadPath = webhookPayloadPath(originalRunId);
  const payloadResult = await deps.logStorage.read(payloadPath);
  if (!payloadResult.data) return null;
  try {
    return JSON.parse(payloadResult.data);
  } catch {
    return null;
  }
}

/** The provider bundle + context a re-run resolves out of the original run's row. */
export interface RerunProviderBinding {
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  providerContext: Record<string, unknown>;
  routingKey: string;
}

/**
 * Resolve the provider bundle and stored provider context for a re-run. Shared
 * by the workflow and evaluation-round re-runs so they cannot disagree about a
 * run's source or how `provider_context` is parsed.
 */
export function resolveRerunProviderBinding(
  originalRun: OriginalRunRow,
  deps: Pick<RerunDeps, 'providerRegistry'>,
): RerunProviderBinding {
  if (!originalRun.routing_key) {
    throw new Error(
      `Re-run failed: original run ${originalRun.run_id} has no routing_key — cannot select provider bundle`,
    );
  }
  const providerBundle = deps.providerRegistry.getByRoutingKey(originalRun.routing_key);
  if (!providerBundle) {
    throw new Error(`Provider bundle for routing key ${originalRun.routing_key} not registered`);
  }
  const providerContext = JSON.parse(
    typeof originalRun.provider_context === 'string'
      ? originalRun.provider_context
      : JSON.stringify(originalRun.provider_context ?? {}),
  );
  return { providerBundle, providerContext, routingKey: originalRun.routing_key };
}

/** How a refusal to rebuild a re-run's inputs names the run and the way forward. */
export interface RerunRefusal {
  /** `Cannot re-run …`. */
  subject: string;
  /** `was deciding` for a round, `ran for` for a run. */
  eventVerb: string;
  remedy: string;
}

export function roundRefusal(originalRun: OriginalRunRow): RerunRefusal {
  return {
    subject: `Cannot re-run evaluation round ${originalRun.run_id}`,
    eventVerb: 'was deciding',
    remedy: "Push a new commit to re-evaluate the organization's workflows.",
  };
}

/**
 * The provider event name + action the original delivery carried.
 *
 * Neither `execution_runs` nor the stored payload has it (the event name is a
 * provider header); it lives in the delivery's `event_log` row, addressed by
 * the run row's delivery id. That row is written at the end of the delivery,
 * after the round's failure is recorded, so every reachable re-run has it.
 *
 * Addressed by `(org_id, delivery_id)` — the table's uniqueness — never by
 * delivery id alone: a generic source takes it verbatim from a sender-supplied
 * header, so one tenant can reuse another's id, and an id-only lookup would
 * re-evaluate one org's globals against another org's event (and pick an
 * unstable row, with no `ORDER BY`).
 */
export async function loadDeliveryEventName(
  originalRun: OriginalRunRow,
  deps: Pick<RerunDeps, 'db'>,
  refusal: RerunRefusal = roundRefusal(originalRun),
): Promise<{ event: string; action: string | null }> {
  const deliveryId = originalRun.delivery_id;
  if (!deliveryId) {
    throw new Error(
      `${refusal.subject}: it records no delivery id, so the event it ${refusal.eventVerb} ` +
        `cannot be identified. ${refusal.remedy}`,
    );
  }
  const row = await deps.db
    .selectFrom('event_log')
    .select(['event', 'action'])
    .where('org_id', '=', originalRun.customer_id)
    .where('delivery_id', '=', deliveryId)
    .executeTakeFirst();
  if (!row?.event) {
    throw new Error(
      `${refusal.subject}: no event log entry for delivery ${deliveryId} is available, so the ` +
        `event it ${refusal.eventVerb} cannot be reconstructed. ${refusal.remedy}`,
    );
  }
  return { event: row.event, action: row.action ?? null };
}

/** The verdict an approved security hold stands for. */
export const RELEASED_DECISION: TrustPolicyOutcome = { action: 'pass' };

/**
 * The normalized delivery the round was deciding, stamped with the default
 * branch as the delivery stamped it: a re-run's jobs carry this event, and an
 * agent derives a new-branch diff from it. Read-only and throwing, so it runs
 * before the requestId claim, never inside the re-evaluation.
 */
export function normalizeRoundEvent(
  originalRun: OriginalRunRow,
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>,
  delivery: { event: string; action: string | null },
  payload: Record<string, unknown>,
  refusal: RerunRefusal = roundRefusal(originalRun),
): SimulatedEvent {
  const event = providerBundle.normalizer.normalizeEvent(delivery.event, delivery.action, payload);
  if (!event) {
    throw new Error(
      `${refusal.subject}: the '${delivery.event}' event it ${refusal.eventVerb} is no longer ` +
        `one this orchestrator normalizes.`,
    );
  }
  return withDefaultBranch(event, payload, providerBundle.normalizer);
}

/**
 * Stamp the re-evaluated event with the source repository's default branch and
 * changed files. Unconditional, unlike the delivery path: a scoped
 * re-evaluation has no source lock file to tell whether path patterns are
 * used. No fetcher, or a fetch error, carries `unavailable`.
 */
export async function withChangedFiles(opts: {
  event: SimulatedEvent;
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  info: WebhookInfo;
  payload: Record<string, unknown>;
  credentials: Record<string, unknown>;
  repoIdentifier: string;
}): Promise<SimulatedEvent> {
  const { bundle, info, payload, credentials, repoIdentifier } = opts;
  const event = withDefaultBranch(opts.event, payload, bundle.normalizer);
  const resolved = await resolveEventChangedFiles({
    bundle,
    credentials,
    repoIdentifier,
    eventName: info.event,
    payload,
    event,
  });
  return { ...stampChangedFiles(event, resolved), sourceRepo: repoIdentifier };
}
