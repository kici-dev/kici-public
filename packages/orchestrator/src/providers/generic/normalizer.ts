/**
 * Generic webhook normalizer.
 *
 * Implements the WebhookNormalizer interface for non-GitHub webhook sources.
 * Handles arbitrary HTTP payloads: JSON and URL-encoded form data.
 * Extracts event type from configurable header or JSONPath in body.
 * Filters sensitive headers per source configuration.
 */

import type { WebhookNormalizer, SimulatedEvent } from '@kici-dev/engine';
import type { GenericSourceManager } from '../../webhook/generic-sources.js';

/**
 * Default headers to strip from generic webhook payloads.
 */
const DEFAULT_STRIP_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
];

/**
 * Generic webhook normalizer implementing WebhookNormalizer from @kici-dev/engine.
 *
 * Transforms arbitrary HTTP webhook payloads into KiCI's universal SimulatedEvent format.
 * Unlike Git providers, generic webhooks have no repo, ref, or SHA -- they carry
 * event payloads from external services (Stripe, Slack, custom APIs, etc.).
 */
export class GenericWebhookNormalizer implements WebhookNormalizer {
  readonly provider = 'generic' as const;

  constructor(private readonly sourceManager: GenericSourceManager) {}

  /**
   * Extract routing key from the X-KiCI-Source-ID header.
   * The route handler sets this header based on the URL path parameter.
   */
  extractRoutingKey(headers: Record<string, string>, _payload: unknown): string | null {
    return headers['x-kici-source-id'] ?? null;
  }

  /**
   * Extract delivery ID from configurable header or generate one.
   * Checks X-Request-ID, X-Delivery-ID, or X-Idempotency-Key headers.
   */
  extractDeliveryId(headers: Record<string, string>): string | null {
    return (
      headers['x-delivery-id'] ?? headers['x-request-id'] ?? headers['x-idempotency-key'] ?? null
    );
  }

  /**
   * Extract event type from configurable header.
   * Falls back to X-Event-Type header.
   */
  extractEventType(headers: Record<string, string>): string | null {
    return headers['x-event-type'] ?? null;
  }

  /**
   * Verify signature -- delegates to the generic verification module.
   * This method is part of the WebhookNormalizer interface but generic webhooks
   * use the separate verifyGenericWebhook function with per-source config.
   * Returns true here as a no-op; actual verification is handled upstream.
   */
  verifySignature(_body: string, _headers: Record<string, string>, _secret: string): boolean {
    // Generic verification is handled by verifyGenericWebhook with per-source config
    // This interface method is not used for generic sources
    return true;
  }

  /**
   * Normalize a generic webhook event into a SimulatedEvent.
   *
   * Generic webhooks produce events with:
   * - type: the extracted event type or 'generic_webhook' fallback
   * - action: undefined (no sub-action concept for generic sources)
   * - targetBranch: '__generic__' (no branch concept)
   * - payload: the raw parsed payload with filtered headers
   * - provider: 'generic'
   */
  normalizeEvent(
    eventType: string,
    _action: string | null,
    payload: unknown,
  ): SimulatedEvent | null {
    return {
      type: 'generic_webhook',
      action: eventType !== 'default' ? eventType : undefined,
      targetBranch: '__generic__',
      payload: (payload as Record<string, unknown>) ?? {},
      provider: 'generic',
    };
  }

  /**
   * Extract repository identifier -- generic webhooks have no repo concept.
   */
  extractRepoIdentifier(_payload: unknown): string | null {
    return null;
  }

  /**
   * Extract ref -- generic webhooks have no ref concept.
   */
  extractRef(_eventType: string, _payload: unknown): string {
    return 'HEAD';
  }

  /**
   * Extract credentials -- generic webhooks carry no provider credentials.
   */
  extractCredentials(_payload: unknown): Record<string, unknown> {
    return {};
  }

  /**
   * Parse and normalize a full generic webhook request.
   *
   * This is the main entry point for generic webhook processing:
   * 1. Looks up source config by routing key
   * 2. Parses body as JSON or URL-encoded form data
   * 3. Extracts event type from configured header or JSONPath in body
   * 4. Filters sensitive headers
   * 5. Returns normalized WebhookData
   *
   * @param routingKey - The routing key for this source (from URL path)
   * @param rawBody - Raw request body string
   * @param headers - Request headers (lowercase keys)
   * @returns Normalized data or null if source not found/disabled
   */
  async normalizeGenericRequest(
    routingKey: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<{
    event: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    routingKey: string;
  } | null> {
    // Look up source config
    const source = await this.sourceManager.getByRoutingKey(routingKey);
    if (!source) {
      return null;
    }

    // Parse body
    const payload = parseBody(rawBody, headers['content-type']);

    // Extract event type
    const event = extractEventType(
      headers,
      payload,
      source.event_type_header,
      source.event_type_path,
    );

    // Filter headers
    const stripHeaders = parseStripHeaders(source.strip_headers);
    const filteredHeaders = filterHeaders(headers, stripHeaders);

    return {
      event,
      payload,
      headers: filteredHeaders,
      routingKey,
    };
  }
}

/**
 * Parse request body as JSON or URL-encoded form data.
 */
export function parseBody(rawBody: string, contentType?: string): Record<string, unknown> {
  if (!rawBody || rawBody.trim() === '') {
    return {};
  }

  // Try JSON first
  if (!contentType || contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      // Fall through to form-encoded
    }
  }

  // Try URL-encoded form data
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(rawBody);
      const result: Record<string, unknown> = {};
      for (const [key, value] of params) {
        result[key] = value;
      }
      return result;
    } catch {
      // Fall through to raw
    }
  }

  // Fallback: wrap raw body
  return { body: rawBody };
}

/**
 * Extract event type from headers or payload path.
 *
 * Priority:
 * 1. Source-configured header (event_type_header)
 * 2. Source-configured JSONPath in body (event_type_path) -- simple dot notation
 * 3. Fallback header X-Event-Type
 * 4. Default: 'default'
 */
export function extractEventType(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  eventTypeHeader?: string | null,
  eventTypePath?: string | null,
): string {
  // 1. Check configured header
  if (eventTypeHeader) {
    const headerValue = headers[eventTypeHeader.toLowerCase()];
    if (headerValue) {
      return headerValue;
    }
  }

  // 2. Check configured JSONPath (simple dot notation, e.g. "event.type")
  if (eventTypePath) {
    const value = getNestedValue(payload, eventTypePath);
    if (typeof value === 'string') {
      return value;
    }
  }

  // 3. Fallback header
  const fallbackType = headers['x-event-type'];
  if (fallbackType) {
    return fallbackType;
  }

  // 4. Default
  return 'default';
}

/**
 * Get a nested value from an object using dot notation.
 * e.g., getNestedValue({a: {b: 'c'}}, 'a.b') => 'c'
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Parse strip_headers from DB (stored as JSON string or array).
 */
function parseStripHeaders(stripHeaders: string | string[]): string[] {
  if (Array.isArray(stripHeaders)) {
    return stripHeaders.map((h) => h.toLowerCase());
  }
  try {
    const parsed = JSON.parse(stripHeaders);
    if (Array.isArray(parsed)) {
      return parsed.map((h: string) => h.toLowerCase());
    }
  } catch {
    // Fallback to defaults
  }
  return DEFAULT_STRIP_HEADERS;
}

/**
 * Filter out sensitive headers.
 */
export function filterHeaders(
  headers: Record<string, string>,
  stripHeaders: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!stripHeaders.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
