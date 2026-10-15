import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { SlidingWindowRateLimiter } from '../helpers/rate-limiter.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { GenericSourceManager } from '../webhook/generic-sources.js';
import {
  verifyGenericWebhook,
  type VerificationConfig,
} from '../providers/generic/verification.js';
import { GenericWebhookNormalizer, getNestedValue } from '../providers/generic/normalizer.js';
import { webhooksReceivedTotal, dedupHitsTotal } from '../metrics/prometheus.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';

const logger = createLogger({ prefix: 'orch:webhooks' });

export interface GenericWebhookRoutesDeps {
  sourceManager: GenericSourceManager;
  /** Hands the delivery to the trigger-matching pipeline. */
  onWebhook: (info: WebhookInfo) => Promise<WebhookIngestOutcome>;
}

/** In-memory, per process. */
const rateLimiter = new SlidingWindowRateLimiter(0);

/** Non-GitHub webhook ingestion: POST /webhook/:orgId/generic/:sourceId. */
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

        // 8. Provider-type branching.
        //
        // provider_type drives which normalizer the pipeline resolves via
        // getByRoutingKey(info.routingKey): 'local' parses the body as a
        // github-shaped push/PR payload tagged provider='local'; 'generic' runs
        // normalizeGenericRequest. Everything else (dedup, rate limit,
        // idempotency, logging, metrics) is SHARED and runs once.
        let info: WebhookInfo;
        let resolvedEvent: string;
        if (source.provider_type === 'local') {
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
          // collisions; the generic branch applies the same rule.
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
          const normalized = await normalizer.normalizeGenericRequest(
            source.routing_key,
            body,
            headers,
          );
          if (!normalized) {
            return c.json({ rejected: true, reason: 'Normalization failed' }, 400);
          }

          // 9. Allowed-events filter, generic only: a filter for local sources
          //    would belong in the pipeline, not this hot path.
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

          // 10. Build WebhookInfo. Scoping deliveryId by routing key stops two
          // sources sharing an idempotency key from colliding in the global dedup_cache.
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

        // 11. Hand to ingest. Resolves once the delivery is DURABLY QUEUED, not
        // matched and dispatched: a provider's delivery attempt times out in
        // seconds while one build phase may take minutes, so waiting for the
        // pipeline would turn a slow build into a failed delivery.
        //
        // The pipeline owns the atomic dedup claim (one chokepoint for the
        // relay, generic, and direct GitHub paths), so the route does no
        // check-then-act; `duplicate` is ingest's advisory probe of a known
        // delivery id, and a cross-instance race is arbitrated by that claim.
        const outcome = await deps.onWebhook(info);

        // Shed (admission control saturated): 429 + Retry-After, and do NOT mark
        // the idempotency key, so a redelivery is processed, not deduped away.
        if (outcome === WebhookIngestOutcome.enum.shed) {
          c.header('Retry-After', '5');
          return c.json(
            {
              rejected: true,
              reason: 'Orchestrator busy, retry later',
              deliveryId: info.deliveryId,
            },
            429,
          );
        }

        // 12. Mark idempotency for the source's dedup window (processed deliveries only).
        if (idempotencyKey && outcome !== WebhookIngestOutcome.enum.duplicate) {
          await deps.sourceManager.markIdempotency(source.id, idempotencyKey);
        }

        // 13. Track metrics + respond.
        webhooksReceivedTotal.add(1, { source: 'generic', event: resolvedEvent });

        logger.info('Generic webhook accepted', {
          orgId,
          sourceId,
          deliveryId: info.deliveryId,
          event: resolvedEvent,
          routingKey: source.routing_key,
          providerType: source.provider_type,
        });

        if (outcome === WebhookIngestOutcome.enum.duplicate) {
          dedupHitsTotal.add(1);
          return c.json({ accepted: true, deliveryId: info.deliveryId, duplicate: true }, 200);
        }
        // 202 = durably queued, NOT matched or dispatched; those outcomes reach
        // the event log, run list and structured logs, never this response.
        return c.json({ accepted: true, deliveryId: info.deliveryId }, 202);
      } catch (err) {
        // Only failures BEFORE the delivery is queued (lookup, verification, the
        // durable write). A pipeline failure happens after the response, as a
        // `failed` event-log row (by `processWebhook`, under the resolved org)
        // plus an `orch:ingest-accept` error line.
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

/** `api_key` maps to bearer_token; an invalid config returns null. */
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

/** Configured header, then configured body path, then fallback headers. */
function extractIdempotencyKey(
  headers: Record<string, string>,
  rawBody: string,
  headerName?: string | null,
  bodyPath?: string | null,
): string | null {
  if (headerName) {
    const value = headers[headerName.toLowerCase()];
    if (value) return value;
  }

  // Simple dot notation.
  if (bodyPath) {
    try {
      const parsed = JSON.parse(rawBody);
      const value = getNestedValue(parsed, bodyPath);
      if (typeof value === 'string') return value;
    } catch {
      // Not JSON, skip
    }
  }

  return headers['x-idempotency-key'] ?? headers['x-delivery-id'] ?? null;
}

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
