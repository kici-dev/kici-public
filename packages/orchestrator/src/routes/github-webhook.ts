import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { WebhookRelayResult } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { SourceStore } from '../sources/source-store.js';
import { verifyInboundWebhook, type VerifyInboundDeps } from '../webhook/verify-inbound.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import { webhooksReceivedTotal, dedupHitsTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'orch:github-webhook' });

/** GitHub caps webhook payloads at 25MB. */
const MAX_GITHUB_PAYLOAD_BYTES = 25 * 1024 * 1024;

/** Dependencies for the direct GitHub webhook ingress route. */
export interface GithubWebhookRoutesDeps {
  /** Local source lookup (by UUID). */
  sourceStore: SourceStore;
  /** Inbound verification deps (db + secret store + generic source manager). */
  verifyDeps: VerifyInboundDeps;
  /** Pipeline entry — owns the atomic dedup claim + dispatch. */
  onWebhook: (info: WebhookInfo) => Promise<WebhookIngestOutcome>;
}

/**
 * Whether the orchestrator serves the direct GitHub ingress route for a given
 * operating mode. Hybrid + independent run local source config; platform mode
 * is relay-only (no local GitHub source to serve).
 */
export function shouldServeGithubIngress(mode: 'platform' | 'hybrid' | 'independent'): boolean {
  return mode === 'hybrid' || mode === 'independent';
}

/**
 * Direct GitHub-App webhook ingress: `POST /webhook/:orgId/github/:sourceId`.
 *
 * Bypasses the Platform relay. Handles both operator topologies on one route:
 *  - App-level repoint: the App's single webhook URL points here, so GitHub
 *    sends `X-GitHub-Hook-Installation-Target-Type: integration` +
 *    `-Target-ID: <appId>` — validated against the source's routing key.
 *  - Classic per-repo webhook: a repo-level hook points here with no App
 *    target headers — `:sourceId` already identifies the source, so the
 *    App-header check is skipped.
 *
 * Verification is the existing local `verify-inbound.ts` GitHub path (secret
 * read from the orchestrator secret store; rotation-aware). Dedup + dispatch
 * are the universal `processWebhook` pipeline via `onWebhook`.
 */
export function createGithubWebhookRoutes(deps: GithubWebhookRoutesDeps): Hono {
  const app = new Hono();

  app.post(
    '/webhook/:orgId/github/:sourceId',
    bodyLimit({ maxSize: MAX_GITHUB_PAYLOAD_BYTES }),
    async (c) => {
      const orgId = c.req.param('orgId');
      const sourceId = c.req.param('sourceId');
      try {
        // 1. Raw body bytes (verbatim — required for HMAC).
        const body = Buffer.from(await c.req.arrayBuffer());

        // 2. Resolve the local GitHub source by id.
        const source = await deps.sourceStore.getSourceById(sourceId);
        if (!source || source.provider !== 'github') {
          return c.json({ rejected: true, reason: 'Unknown source' }, 404);
        }

        // 3. App-header handling (covers both topologies).
        const targetType = c.req.header('x-github-hook-installation-target-type');
        const targetId = c.req.header('x-github-hook-installation-target-id');
        if (targetType !== undefined || targetId !== undefined) {
          // App-level repoint: validate the installation-target headers.
          if (targetType !== 'integration' || !targetId) {
            return c.json({ rejected: true, reason: 'Invalid GitHub App target headers' }, 400);
          }
          const headerAppId = Number.parseInt(targetId, 10);
          if (Number.isNaN(headerAppId)) {
            return c.json({ rejected: true, reason: 'Invalid App ID' }, 400);
          }
          if (source.routing_key !== `github:${headerAppId}`) {
            return c.json({ rejected: true, reason: 'App ID does not match source' }, 400);
          }
        }
        // else: classic per-repo webhook — :sourceId identifies the source.

        // 4. Delivery + event metadata.
        const deliveryId = c.req.header('x-github-delivery');
        const event = c.req.header('x-github-event');
        if (!deliveryId || !event) {
          return c.json({ rejected: true, reason: 'Missing required GitHub headers' }, 400);
        }

        // 5. Collect lowercased headers + signature for verification.
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const signature256 = c.req.header('x-hub-signature-256');
        const signature1 = c.req.header('x-hub-signature');
        const signatureHeader = signature256 ?? signature1 ?? null;
        const signatureHeaderName = signature256
          ? 'x-hub-signature-256'
          : signature1
            ? 'x-hub-signature'
            : null;
        const clientIp =
          headers['x-forwarded-for']?.split(',')[0]?.trim() ?? headers['x-real-ip'] ?? null;

        // 6. Verify the signature locally (rotation-aware GitHub path).
        const outcome = await verifyInboundWebhook(deps.verifyDeps, {
          routingKey: source.routing_key,
          body,
          headers,
          signatureHeaderName,
          signatureHeader,
          clientIp,
        });
        if (outcome.result === WebhookRelayResult.enum.rejected_signature) {
          webhooksReceivedTotal.add(1, { source: 'github-direct', event: 'unknown' });
          return c.json({ rejected: true, reason: outcome.reason ?? 'Invalid signature' }, 401);
        }
        if (outcome.result === WebhookRelayResult.enum.rejected_unknown_source) {
          return c.json({ rejected: true, reason: outcome.reason ?? 'Unknown source' }, 404);
        }
        if (outcome.result === WebhookRelayResult.enum.rejected_misconfigured) {
          return c.json({ rejected: true, reason: outcome.reason ?? 'Source misconfigured' }, 422);
        }

        // 7. Parse payload + build WebhookInfo. The deliveryId is the raw
        // X-GitHub-Delivery (NOT scoped by routing key) so a hybrid delivery
        // arriving by both relay and direct paths dedups to the same claim.
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          return c.json({ rejected: true, reason: 'Body is not valid JSON' }, 400);
        }
        const action = typeof payload.action === 'string' ? payload.action : null;

        const info: WebhookInfo = {
          routingKey: source.routing_key,
          deliveryId,
          event,
          action,
          provider: 'github',
          payload,
        };

        // 8. Process through the pipeline (atomic dedup + dispatch).
        const ingest = await deps.onWebhook(info);
        webhooksReceivedTotal.add(1, { source: 'github-direct', event });
        logger.info('Direct GitHub webhook accepted', {
          orgId,
          sourceId,
          deliveryId,
          event,
          routingKey: source.routing_key,
          ingest,
        });
        if (ingest === WebhookIngestOutcome.enum.duplicate) {
          dedupHitsTotal.add(1);
          return c.json({ accepted: true, deliveryId, duplicate: true }, 200);
        }
        return c.json({ accepted: true, deliveryId }, 202);
      } catch (err) {
        logger.error('Direct GitHub webhook processing error', {
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
