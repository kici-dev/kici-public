import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { WebhookRelayResult, OWN_INGRESS_MODES, githubIngressPath } from '@kici-dev/engine';
import type { OrchestratorMode } from '@kici-dev/engine';
import type { Source } from '../db/types.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { SourceStore } from '../sources/source-store.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import { verifyInboundWebhook, type VerifyInboundDeps } from '../webhook/verify-inbound.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import { webhooksReceivedTotal, dedupHitsTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'orch:github-webhook' });

/** GitHub caps webhook payloads at 25MB — cluster-wide fallback default. */
const MAX_GITHUB_PAYLOAD_BYTES = 25 * 1024 * 1024;

/** Dependencies for the direct GitHub webhook ingress route. */
export interface GithubWebhookRoutesDeps {
  /** Local source lookup (by UUID). */
  sourceStore: SourceStore;
  /** Inbound verification deps (db + secret store + generic source manager). */
  verifyDeps: VerifyInboundDeps;
  /** Pipeline entry — owns the atomic dedup claim + dispatch. */
  onWebhook: (info: WebhookInfo) => Promise<WebhookIngestOutcome>;
  /** Fleet-wide settings reader; overrides the payload cap per request. */
  clusterSettings?: ClusterSettingsReader;
  /** Cluster default payload cap (bytes) when no cluster_settings override is set. */
  maxGithubPayloadBytes?: number;
}

/**
 * Whether the orchestrator serves the direct GitHub ingress route for a given
 * operating mode. Hybrid, independent, and observed modes serve their own
 * ingress; platform mode is relay-only (no local GitHub source to serve).
 */
export function shouldServeGithubIngress(mode: OrchestratorMode): boolean {
  return OWN_INGRESS_MODES.includes(mode);
}

/** The local GitHub source a delivery belongs to, or the answer that refuses it. */
type SourceResolution = { source: Source } | { rejection: { status: 400 | 404; reason: string } };

type SourceResolver = (c: Context) => Promise<SourceResolution>;

/** Which of the two routes a delivery arrived on, for logs. */
type IngressRoute = 'source' | 'org';

const UNKNOWN_SOURCE: SourceResolution = { rejection: { status: 404, reason: 'Unknown source' } };

/**
 * Read the App installation-target headers GitHub sets on an App-level
 * delivery. `null` when neither header is present: a classic repository hook.
 */
function readAppTarget(c: Context): { appId: number } | { invalid: string } | null {
  const targetType = c.req.header('x-github-hook-installation-target-type');
  const targetId = c.req.header('x-github-hook-installation-target-id');
  if (targetType === undefined && targetId === undefined) return null;
  if (targetType !== 'integration' || !targetId) {
    return { invalid: 'Invalid GitHub App target headers' };
  }
  const appId = Number.parseInt(targetId, 10);
  if (Number.isNaN(appId)) return { invalid: 'Invalid App ID' };
  return { appId };
}

/**
 * `/webhook/:orgId/github/:sourceId`: the URL names the source. App headers,
 * when present (an App-level repoint), must match it; a classic repository
 * hook sends none.
 */
function resolveBySourceId(deps: GithubWebhookRoutesDeps): SourceResolver {
  return async (c) => {
    const source = await deps.sourceStore.getSourceById(c.req.param('sourceId') ?? '');
    if (!source || source.provider !== 'github') return UNKNOWN_SOURCE;
    const target = readAppTarget(c);
    if (target === null) return { source };
    if ('invalid' in target) return { rejection: { status: 400, reason: target.invalid } };
    if (source.routing_key !== `github:${target.appId}`) {
      return { rejection: { status: 400, reason: 'App ID does not match source' } };
    }
    return { source };
  };
}

/**
 * `/webhook/:orgId/github`: the App's target id names the source. This URL
 * exists before the App does, so the manifest flow can bake it in. A
 * repository hook carries no App headers and must use the per-source URL.
 */
function resolveByAppId(deps: GithubWebhookRoutesDeps): SourceResolver {
  return async (c) => {
    const target = readAppTarget(c);
    if (target === null) {
      const perSource = githubIngressPath(c.req.param('orgId') ?? '', '<source-id>');
      return {
        rejection: {
          status: 400,
          reason:
            `Missing GitHub App target headers. A repository webhook must use the per-source URL ` +
            `(${perSource}) that kici-admin source list prints.`,
        },
      };
    }
    if ('invalid' in target) return { rejection: { status: 400, reason: target.invalid } };
    const source = await deps.sourceStore.getSource(`github:${target.appId}`);
    if (!source || source.provider !== 'github') return UNKNOWN_SOURCE;
    return { source };
  };
}

/**
 * The delivery handler both routes share: resolve the source, verify the
 * signature locally, parse, and hand the delivery to ingest.
 */
function createDeliveryHandler(
  deps: GithubWebhookRoutesDeps,
  resolve: SourceResolver,
  route: IngressRoute,
) {
  return async (c: Context) => {
    const orgId = c.req.param('orgId') ?? '';
    try {
      // 1. Raw body bytes (verbatim — required for HMAC).
      const body = Buffer.from(await c.req.arrayBuffer());

      // 2. Resolve the local GitHub source (the resolver owns the App headers).
      const resolution = await resolve(c);
      if ('rejection' in resolution) {
        return c.json(
          { rejected: true, reason: resolution.rejection.reason },
          resolution.rejection.status,
        );
      }
      const { source } = resolution;

      // 3. Delivery + event metadata.
      const deliveryId = c.req.header('x-github-delivery');
      const event = c.req.header('x-github-event');
      if (!deliveryId || !event) {
        return c.json({ rejected: true, reason: 'Missing required GitHub headers' }, 400);
      }

      // 4. Collect lowercased headers + signature for verification.
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

      // 5. Verify the signature locally (rotation-aware GitHub path).
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

      // 6. Parse payload + build WebhookInfo. The deliveryId is the raw
      // X-GitHub-Delivery (NOT scoped by routing key or route) so a delivery
      // arriving by the relay and by either direct route dedups to the same claim.
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

      // 7. Hand the delivery to ingest. Resolves once the delivery is DURABLY
      // QUEUED, not once it has been matched and dispatched: GitHub abandons a
      // delivery after 10 seconds, while one matched workflow's build phase
      // alone may legitimately take minutes. The pipeline still owns the
      // atomic dedup claim.
      const ingest = await deps.onWebhook(info);
      webhooksReceivedTotal.add(1, { source: 'github-direct', event });
      logger.info('Direct GitHub webhook accepted', {
        orgId,
        sourceId: source.id,
        route,
        deliveryId,
        event,
        routingKey: source.routing_key,
        ingest,
      });
      if (ingest === WebhookIngestOutcome.enum.duplicate) {
        dedupHitsTotal.add(1);
        return c.json({ accepted: true, deliveryId, duplicate: true }, 200);
      }
      if (ingest === WebhookIngestOutcome.enum.shed) {
        c.header('Retry-After', '5');
        return c.json(
          { rejected: true, reason: 'Orchestrator busy, retry later', deliveryId },
          429,
        );
      }
      // 202 = accepted and durably queued; it asserts nothing about matching
      // or dispatch. Those outcomes reach the event log and the run list.
      return c.json({ accepted: true, deliveryId }, 202);
    } catch (err) {
      // Reachable only for a failure BEFORE the delivery is queued. A pipeline
      // failure surfaces as a `failed` event-log row (written by
      // `processWebhook`, under the delivery's resolved org) plus an
      // `orch:ingest-accept` error line, not as a 500 here.
      logger.error('Direct GitHub webhook processing error', {
        orgId,
        route,
        error: toErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return c.json({ error: 'Internal server error' }, 500);
    }
  };
}

/**
 * Direct GitHub webhook ingress, bypassing the Platform relay:
 *
 *  - `POST /webhook/:orgId/github/:sourceId` (per-source) serves an App-level
 *    repoint (GitHub sends `X-GitHub-Hook-Installation-Target-Type:
 *    integration` + `-Target-ID: <appId>`, validated against the source's
 *    routing key) and a classic repository hook (no App target headers;
 *    `:sourceId` identifies the source).
 *  - `POST /webhook/:orgId/github` (org-scoped) serves an App-level webhook:
 *    the App's target id names the source. It is the URL the manifest flow
 *    bakes into a new App in observed and independent mode.
 *
 * Both routes share verification (the local `verify-inbound.ts` GitHub path,
 * secret read from the orchestrator secret store, rotation-aware), dedup on the
 * raw `X-GitHub-Delivery`, and ingest through the `processWebhook` pipeline via
 * `onWebhook`.
 */
export function createGithubWebhookRoutes(deps: GithubWebhookRoutesDeps): Hono {
  const app = new Hono();

  // Per-request body cap: a live cluster override wins over the config
  // default; Hono's bodyLimit rejects an over-Content-Length request and aborts
  // a chunked body with 413 the moment it passes the cap, so a hostile chunked
  // request can never buffer an unbounded body into memory.
  const payloadCap: MiddlewareHandler = async (c, next) => {
    const maxSize =
      (await deps.clusterSettings?.getNumber(
        'max_github_payload_bytes',
        deps.maxGithubPayloadBytes ?? MAX_GITHUB_PAYLOAD_BYTES,
      )) ??
      deps.maxGithubPayloadBytes ??
      MAX_GITHUB_PAYLOAD_BYTES;
    return bodyLimit({
      maxSize,
      onError: (c) => c.json({ rejected: true, reason: 'Payload too large' }, 413),
    })(c, next);
  };

  app.post(
    '/webhook/:orgId/github/:sourceId',
    payloadCap,
    createDeliveryHandler(deps, resolveBySourceId(deps), 'source'),
  );
  app.post(
    '/webhook/:orgId/github',
    payloadCap,
    createDeliveryHandler(deps, resolveByAppId(deps), 'org'),
  );
  return app;
}
