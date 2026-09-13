/**
 * Durable breadcrumb for a webhook relay the ingest admission controller shed.
 *
 * A shed happens BEFORE the pipeline that writes every other `event_log`
 * status, so without this row a shed delivery leaves nothing queryable by
 * delivery id: the durable overflow row is internal to the replayer and is
 * deleted the moment a replay succeeds, and the shed itself survives only as a
 * log line. An operator (and an E2E assertion) then cannot tell a delivery that
 * was shed and is waiting for replay from one that never arrived at all.
 *
 * The row is written with `onlyIfAbsent`, so it never overwrites an outcome the
 * pipeline already reached for the same delivery — a re-shed of an
 * already-processed delivery must not downgrade its row back to `shed`. A
 * later successful replay upgrades the SAME row to its real outcome through
 * the normal upsert, keeping the payload this write stored.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { EventLogSource, EventLogStatus, type ProviderType } from '@kici-dev/engine';
import type { EventLogWriter } from './event-log.js';
import type { RelayStartMeta } from './relay-buffer.js';

const logger = createLogger({ prefix: 'shed-breadcrumb' });

export interface ShedBreadcrumbDeps {
  /** Writer for the orchestrator `event_log`. Absent in wirings with no log. */
  eventLog: EventLogWriter | undefined;
  /** Routing key → owning org id. Must not throw; returns the resolved tenant. */
  resolveOrgId: (routingKey: string) => Promise<string>;
}

/**
 * Provider for a pre-verify relay delivery.
 *
 * The shed runs before signature verification resolves a provider bundle, so
 * the routing-key prefix is all that is available — the same fallback the relay
 * ingest and replay paths use when no bundle is registered yet. `event_log`
 * requires a non-null provider, so an unparseable key degrades to the routing
 * key itself rather than dropping the breadcrumb.
 */
function providerFromRoutingKey(routingKey: string): ProviderType {
  return (routingKey.split(':')[0] || routingKey) as ProviderType;
}

/**
 * Record that a relay delivery was shed. Best-effort and never throws: a
 * breadcrumb failure must not change the `shed_retry_later` ack the sender
 * gets. Returns whether a write was attempted and completed.
 */
export async function recordShedBreadcrumb(
  deps: ShedBreadcrumbDeps,
  meta: RelayStartMeta,
  body: Buffer,
  reason: string,
): Promise<boolean> {
  if (!deps.eventLog) return false;
  try {
    const orgId = await deps.resolveOrgId(meta.routingKey);
    await deps.eventLog.record(
      {
        routingKey: meta.routingKey,
        deliveryId: meta.deliveryId,
        event: meta.event,
        action: meta.action ?? null,
        provider: providerFromRoutingKey(meta.routingKey),
        // `record` hashes and stores the bytes passed below; it never reads
        // this field, and the shed runs before anything parses the body.
        payload: {},
      },
      // The verbatim wire body — the same bytes Platform hashed, so the
      // cross-tier payload hash matches for a delivery that was shed.
      { raw: body },
      {
        orgId,
        source: EventLogSource.enum.relay,
        status: EventLogStatus.enum.shed,
        errorMessage: `ingest admission shed: ${reason}`,
      },
      { onlyIfAbsent: true },
    );
    return true;
  } catch (err) {
    logger.warn('Failed to record shed breadcrumb for relay delivery', {
      deliveryId: meta.deliveryId,
      routingKey: meta.routingKey,
      error: toErrorMessage(err),
    });
    return false;
  }
}
