import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { SlidingWindowRateLimiter } from '../helpers/rate-limiter.js';
import type { DedupCache } from '../webhook/dedup.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { GenericSourceManager } from '../webhook/generic-sources.js';
import {
  verifyGenericWebhook,
  type VerificationConfig,
} from '../providers/generic/verification.js';
import { GenericWebhookNormalizer, getNestedValue } from '../providers/generic/normalizer.js';
import { webhooksReceivedTotal, dedupHitsTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'orch:webhooks' });

/**
 * Dependencies for generic webhook routes.
 */
export interface GenericWebhookRoutesDeps {
  /** Generic source manager for source lookup and validation */
  sourceManager: GenericSourceManager;
  /** Delivery ID deduplication cache */
  dedup: DedupCache;
  /** Processing callback -- connects to the trigger matching pipeline */
  onWebhook: (info: WebhookInfo) => Promise<void>;
}

/** In-memory sliding-window rate limiter for generic webhook sources */
const rateLimiter = new SlidingWindowRateLimiter(0);

/**
 * Create generic webhook routes for non-GitHub webhook ingestion.
 *
 * Endpoint: POST /webhook/:orgId/generic/:sourceId
 *
 * Handler flow:
 * 1. Read raw body
 * 2. Look up source from GenericSourceManager
 * 3. Check payload size
 * 4. Rate limit check
 * 5. Verify signature using per-source verification config
 * 6. Extract idempotency key, check dedup
 * 7. Extract event type, check allowed events
 * 8. Normalize and process through pipeline
 * 9. Return response
 *
 * @param deps - Dependencies (source manager, dedup cache, processing callback)
 * @returns Hono app with generic webhook routes
 */
export function createGenericWebhookRoutes(deps: GenericWebhookRoutesDeps): Hono {
  const app = new Hono();
  const normalizer = new GenericWebhookNormalizer(deps.sourceManager);

  app.post(
    '/webhook/:orgId/generic/:sourceId',
    bodyLimit({ maxSize: 10 * 1024 * 1024 }), // 10MB upper bound; per-source limit checked below
    async (c) => {
      const orgId = c.req.param('orgId');
      const sourceId = c.req.param('sourceId');

      try {
        // 1. Read raw body
        const body = await c.req.text();

        // 2. Look up source by org + name
        const source = await deps.sourceManager.getByOrgAndName(orgId, sourceId);
        if (!source || !source.enabled) {
          return c.json({ rejected: true, reason: 'Unknown source' }, 404);
        }

        // 3. Check payload size (use byte length, not character count)
        if (Buffer.byteLength(body, 'utf-8') > source.max_payload_bytes) {
          return c.json(
            {
              rejected: true,
              reason: 'Payload too large',
              maxBytes: source.max_payload_bytes,
            },
            413,
          );
        }

        // 4. Rate limit check
        const rateResult = rateLimiter.check(source.id, source.rate_limit_rpm);
        if (!rateResult.allowed) {
          const retryAfter = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
          c.header('Retry-After', String(retryAfter));
          return c.json({ rejected: true, reason: 'Rate limit exceeded' }, 429);
        }

        // 5. Collect headers (lowercase keys)
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        // 6. Verify signature
        const verificationConfig = parseVerificationConfig(
          source.verification_method,
          source.verification_config,
        );
        if (!verificationConfig && source.verification_method !== 'none') {
          logger.error('Source has invalid verification config', {
            sourceId: source.id,
            method: source.verification_method,
          });
          return c.json({ rejected: true, reason: 'Source verification misconfigured' }, 500);
        }
        if (verificationConfig) {
          const clientIp =
            headers['x-forwarded-for']?.split(',')[0]?.trim() ?? headers['x-real-ip'] ?? undefined;
          const valid = verifyGenericWebhook(body, headers, verificationConfig, clientIp);
          if (!valid) {
            webhooksReceivedTotal.add(1, { source: 'generic', event: 'unknown' });
            return c.json({ rejected: true, reason: 'Invalid signature' }, 401);
          }
        }

        // 7. Extract idempotency key and check dedup
        const idempotencyKey = extractIdempotencyKey(
          headers,
          body,
          source.idempotency_key_header,
          source.idempotency_key_path,
        );
        if (idempotencyKey) {
          const isDuplicate = await deps.sourceManager.checkIdempotency(source.id, idempotencyKey);
          if (isDuplicate) {
            dedupHitsTotal.add(1);
            return c.json({ accepted: true, duplicate: true }, 200);
          }
        }

        // 8. Provider-type branching (gap closure).
        //
        // generic_webhook_sources.provider_type drives which normalizer the
        // pipeline processor will resolve via getByRoutingKey(info.routingKey).
        // For 'local' sources the normalize step parses the body as a
        // github-shaped push/PR payload and tags info.provider='local'.
        // For 'generic' sources the existing normalizeGenericRequest path
        // runs. All other logic (dedup, rate limit, idempotency, logging,
        // metrics) is SHARED between the two branches — only the lines below
        // differ, everything before and after this block runs once.
        let info: WebhookInfo;
        let resolvedEvent: string;
        if (source.provider_type === 'local') {
          // Local sources expect github-shaped JSON + x-event-type header.
          let parsedPayload: Record<string, unknown>;
          try {
            parsedPayload = JSON.parse(body) as Record<string, unknown>;
          } catch {
            return c.json({ rejected: true, reason: 'Local source requires JSON body' }, 400);
          }
          const localEvent = headers['x-event-type'];
          if (!localEvent) {
            return c.json(
              { rejected: true, reason: 'Missing x-event-type header for local source' },
              400,
            );
          }
          const localAction =
            typeof parsedPayload.action === 'string' ? parsedPayload.action : null;

          // Scope deliveryId by routing key to prevent cross-source dedup
          // collisions. SHARED with the generic branch below — same scoping
          // rule applies regardless of which normalizer ran.
          const rawDeliveryId =
            idempotencyKey ?? headers['x-delivery-id'] ?? headers['x-request-id'] ?? randomUUID();
          const deliveryId = `${source.routing_key}:${rawDeliveryId}`;

          info = {
            routingKey: source.routing_key,
            deliveryId,
            event: localEvent,
            action: localAction,
            provider: 'local',
            payload: parsedPayload,
          };
          resolvedEvent = localEvent;
        } else {
          // Existing generic path — untouched.
          const normalized = await normalizer.normalizeGenericRequest(
            source.routing_key,
            body,
            headers,
          );
          if (!normalized) {
            return c.json({ rejected: true, reason: 'Normalization failed' }, 400);
          }

          // 9. Check allowed events filter (generic-only — local sources
          //    pass the event-type header through and any future allowed-event
          //    filter for them would live in the orchestrator pipeline, not
          //    this hot path).
          const allowedEvents = parseJsonArray(source.allowed_events);
          if (allowedEvents && allowedEvents.length > 0) {
            if (!allowedEvents.includes(normalized.event)) {
              return c.json(
                {
                  accepted: true,
                  status: 'filtered',
                  reason: `Event '${normalized.event}' not in allowed list`,
                },
                200,
              );
            }
          }

          // 10. Build WebhookInfo and process
          // Scope deliveryId by routing key to prevent cross-source false-positive dedup.
          // Without this, two different sources sharing the same idempotency key would
          // collide in the global dedup_cache.
          const rawDeliveryId =
            idempotencyKey ?? normalizer.extractDeliveryId(headers) ?? randomUUID();
          const deliveryId = `${source.routing_key}:${rawDeliveryId}`;

          info = {
            routingKey: source.routing_key,
            deliveryId,
            event: normalized.event,
            action: null,
            provider: 'generic',
            payload: normalized.payload,
          };
          resolvedEvent = normalized.event;
        }

        // 11. Dedup check via main dedup cache
        if (await deps.dedup.exists(info.deliveryId)) {
          dedupHitsTotal.add(1);
          return c.json({ accepted: true, deliveryId: info.deliveryId, duplicate: true }, 200);
        }

        // 12. Process through pipeline
        await deps.onWebhook(info);

        // 13. Mark as processed
        await deps.dedup.mark(info.deliveryId);

        // 13b. Record idempotency marker for source-specific dedup window
        if (idempotencyKey) {
          await deps.sourceManager.markIdempotency(source.id, idempotencyKey);
        }

        // 14. Track metrics
        webhooksReceivedTotal.add(1, { source: 'generic', event: resolvedEvent });

        logger.info('Generic webhook accepted', {
          orgId,
          sourceId,
          deliveryId: info.deliveryId,
          event: resolvedEvent,
          routingKey: source.routing_key,
          providerType: source.provider_type,
        });

        return c.json({ accepted: true, deliveryId: info.deliveryId }, 202);
      } catch (err) {
        logger.error('Generic webhook processing error', {
          orgId,
          sourceId,
          error: toErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return c.json({ error: 'Internal server error' }, 500);
      }
    },
  );

  return app;
}

/**
 * Parse verification config from DB storage format.
 */
function parseVerificationConfig(
  method: string,
  configJson: string | Record<string, unknown>,
): VerificationConfig | null {
  let config: Record<string, unknown>;
  try {
    config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
  } catch {
    return null;
  }

  switch (method) {
    case 'hmac_sha256': {
      if (!config.secret || typeof config.secret !== 'string') {
        return null;
      }
      return {
        method: 'hmac_sha256',
        secret: config.secret,
        headerName: typeof config.headerName === 'string' ? config.headerName : undefined,
      };
    }
    case 'bearer_token': {
      if (!config.token || typeof config.token !== 'string') {
        return null;
      }
      return {
        method: 'bearer_token',
        token: config.token,
        headerName: typeof config.headerName === 'string' ? config.headerName : undefined,
      };
    }
    case 'ip_allowlist': {
      if (!Array.isArray(config.allowlist)) {
        return null;
      }
      return {
        method: 'ip_allowlist',
        allowlist: config.allowlist as string[],
      };
    }
    case 'api_key': {
      if (!config.key || typeof config.key !== 'string') {
        return null;
      }
      return {
        method: 'bearer_token',
        token: config.key,
        headerName: typeof config.header === 'string' ? config.header : undefined,
      };
    }
    case 'none':
      return { method: 'none' };
    default:
      return null;
  }
}

/**
 * Extract idempotency key from headers or body path.
 */
function extractIdempotencyKey(
  headers: Record<string, string>,
  rawBody: string,
  headerName?: string | null,
  bodyPath?: string | null,
): string | null {
  // Check configured header
  if (headerName) {
    const value = headers[headerName.toLowerCase()];
    if (value) return value;
  }

  // Check configured body path (simple dot notation)
  if (bodyPath) {
    try {
      const parsed = JSON.parse(rawBody);
      const value = getNestedValue(parsed, bodyPath);
      if (typeof value === 'string') return value;
    } catch {
      // Not JSON, skip
    }
  }

  // Fallback headers
  return headers['x-idempotency-key'] ?? headers['x-delivery-id'] ?? null;
}

/**
 * Parse a JSON array from a DB column value.
 */
function parseJsonArray(value: string | string[] | null): string[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not valid JSON
  }
  return null;
}
