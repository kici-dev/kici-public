import { z } from 'zod';
import type { ProviderType } from '@kici-dev/engine';
import type { WebhookInfo } from './handler.js';
import type { RelayStartMeta } from './relay-buffer.js';

/**
 * Lifecycle of a durably-buffered shed delivery.
 *
 * - `buffered`  — captured, awaiting replay.
 * - `replaying` — claimed by a replay pass (a conditional-update lock so a
 *   restart / second loop cannot double-claim the same row).
 * - `replayed`  — successfully re-injected through normal ingest; swept.
 * - `failed`    — re-shed / errored past the max-attempts ceiling; kept for
 *   operator inspection with `last_error`.
 */
export const OverflowStatus = z.enum(['buffered', 'replaying', 'replayed', 'failed']);
export type OverflowStatus = z.infer<typeof OverflowStatus>;

/**
 * Which ingest boundary captured the delivery, and therefore how it is replayed:
 *
 * - `direct` — HTTP direct-ingress. The delivery was already signature-verified
 *   and normalized at ingest; replay re-injects the stored `WebhookInfo` through
 *   the admission-gated HTTP path (no re-verification).
 * - `relay`  — Platform-WS relay. The delivery was shed BEFORE signature
 *   verification; replay MUST re-verify the raw body against the stored headers.
 */
export const OverflowSourceKind = z.enum(['direct', 'relay']);
export type OverflowSourceKind = z.infer<typeof OverflowSourceKind>;

/** Reasons a delivery is permanently dropped from the overflow buffer. */
export const OverflowDropReason = z.enum(['cap_full', 'max_attempts']);
export type OverflowDropReason = z.infer<typeof OverflowDropReason>;

/** Verify-input envelope for a `relay`-origin delivery (mirrors RelayStartMeta). */
export interface OverflowRelayMeta {
  signatureHeaderName: string | null;
  signatureHeader: string | null;
  clientIp: string | null;
  headers: Record<string, string>;
  requestId?: string;
}

/** A delivery captured for durable overflow replay. */
export interface OverflowDelivery {
  deliveryId: string;
  routingKey: string;
  sourceKind: OverflowSourceKind;
  /** Provider type (direct: from WebhookInfo; relay: resolved at replay). */
  provider: string | null;
  event: string;
  action: string | null;
  /**
   * Base64 of the raw delivery bytes. For `direct` this is the JSON-serialized
   * payload; for `relay` it is the verbatim wire body (base64 preserves bytes so
   * a non-JSON generic payload replays intact and HMAC re-verification matches).
   */
  body: string;
  /** Verify metadata; empty for `direct` (already verified). */
  meta: OverflowRelayMeta;
}

const EMPTY_META: OverflowRelayMeta = {
  signatureHeaderName: null,
  signatureHeader: null,
  clientIp: null,
  headers: {},
};

/** Build a capture record from a verified HTTP-direct `WebhookInfo`. */
export function deliveryFromDirect(info: WebhookInfo): OverflowDelivery {
  return {
    deliveryId: info.deliveryId,
    routingKey: info.routingKey,
    sourceKind: OverflowSourceKind.enum.direct,
    provider: info.provider,
    event: info.event,
    action: info.action,
    body: Buffer.from(JSON.stringify(info.payload), 'utf8').toString('base64'),
    meta: EMPTY_META,
  };
}

/** Build a capture record from a pre-verify WS relay `meta` + raw body. */
export function deliveryFromRelay(meta: RelayStartMeta, body: Buffer): OverflowDelivery {
  return {
    deliveryId: meta.deliveryId,
    routingKey: meta.routingKey,
    sourceKind: OverflowSourceKind.enum.relay,
    provider: null,
    event: meta.event,
    action: meta.action ?? null,
    body: body.toString('base64'),
    meta: {
      signatureHeaderName: meta.signatureHeaderName ?? null,
      signatureHeader: meta.signatureHeader ?? null,
      clientIp: meta.clientIp ?? null,
      headers: meta.headers,
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
    },
  };
}

/** Reconstruct a normalized `WebhookInfo` from a `direct`-origin delivery. */
export function overflowDeliveryToInfo(d: OverflowDelivery): WebhookInfo {
  const payload = JSON.parse(Buffer.from(d.body, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
  return {
    routingKey: d.routingKey,
    deliveryId: d.deliveryId,
    event: d.event,
    action: d.action,
    provider: (d.provider ?? 'github') as ProviderType,
    payload,
  };
}
