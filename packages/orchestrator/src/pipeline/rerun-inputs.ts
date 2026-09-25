/**
 * Inputs every re-run path rebuilds from an original run: its stored webhook
 * payload, the provider binding its row records, the delivery's event name, the
 * normalized event, and its changed files. Shared by the per-repository re-run,
 * the evaluation-round re-run and release, and the cross-repository global
 * re-run, so the paths cannot disagree about how a run's inputs are read back.
 */
import { createLogger } from '@kici-dev/shared';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { ProviderRegistry } from '../provider-registry.js';
import type { TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { WebhookInfo } from '../webhook/handler.js';
import { webhookPayloadPath } from './webhook-payload-store.js';
import type { OriginalRunRow, RerunDeps } from './rerun.js';

const logger = createLogger({ prefix: 'rerun' });

/**
 * Load the original webhook payload from object storage. Returns
 * null for cron/schedule runs (no payload was stored) or when the payload
 * cannot be parsed.
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
    // Corrupted or unparseable payload — treat as missing
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
 * Resolve the provider bundle and stored provider context for a run being
 * re-run.
 *
 * Shared by the workflow re-run and the evaluation-round re-run so the two
 * cannot disagree about which source a run belongs to, or about how its
 * `provider_context` column is parsed.
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
  /** The sentence's opening, naming the run: `Cannot re-run …`. */
  subject: string;
  /** How the run relates to its event: `was deciding` for a round, `ran for` for a run. */
  eventVerb: string;
  /** What the caller can do instead. */
  remedy: string;
}

/** The refusal wording for a global evaluation round. */
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
 * `execution_runs` records neither: the event name arrives in a provider header,
 * not in the payload, so it cannot be recovered from the stored payload either.
 * The delivery's own `event_log` row is where it lives, and a round's run row
 * carries the delivery id that addresses it. That row is written at the end of
 * the delivery, after the round's failure is recorded, so it is present for
 * every re-run an operator can actually reach.
 *
 * Addressed by `(org_id, delivery_id)` — the table's own uniqueness — never by
 * the delivery id alone. A generic source's delivery id is taken verbatim from
 * a sender-supplied header, so one tenant can choose an id another tenant's
 * round already carries; a lookup by id alone would then re-evaluate one org's
 * global workflows against another org's event shape, and with no `ORDER BY`
 * the row it picked would not even be stable.
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
 * The normalized form of the delivery the round was deciding.
 *
 * Read-only, and it throws — so it runs before the requestId claim, never
 * inside the re-evaluation.
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
  return event;
}

/**
 * Stamp the re-evaluated event with the source repository's changed files.
 *
 * Unconditional, unlike the delivery path's fetch: that path skips the fetch
 * when no trigger in the source repo's lock file uses path patterns, and a
 * scoped re-evaluation has no such lock file to read. An error carries
 * `unavailable`, which every path filter downstream already treats
 * conservatively.
 */
export async function withChangedFiles(opts: {
  event: SimulatedEvent;
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  info: WebhookInfo;
  payload: Record<string, unknown>;
  credentials: Record<string, unknown>;
  repoIdentifier: string;
}): Promise<SimulatedEvent> {
  const { event, bundle, info, payload, credentials, repoIdentifier } = opts;
  const base: SimulatedEvent = { ...event, sourceRepo: repoIdentifier };
  if (!bundle.changedFilesFetcher) {
    return { ...base, changedFiles: [], changedFilesStatus: 'unavailable' };
  }
  try {
    const fetched = await bundle.changedFilesFetcher.getChangedFiles(
      repoIdentifier,
      info.event,
      payload,
      credentials,
    );
    return { ...base, changedFiles: fetched.files, changedFilesStatus: fetched.status };
  } catch (err) {
    logger.warn('Changed files unavailable for an eval-round rerun', {
      repoIdentifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, changedFiles: [], changedFilesStatus: 'unavailable' };
  }
}
