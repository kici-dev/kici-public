/**
 * Trigger an offline routed run against the local plane and discover its runId.
 *
 * A local repo has no forge to send a webhook, so this posts a GitHub-shaped
 * synthetic push to the plane's provider-agnostic generic webhook route (the
 * same wire shape the `kici-admin source trigger-local` path builds). The
 * webhook is unauthenticated (the edge accepts it and returns 202); the run is
 * created asynchronously, so this then polls the admin runs list — authenticated
 * with the plane's bootstrap admin token — to resolve the created runId.
 *
 * The source's bundle hot-reload is debounced, so a first trigger can land
 * before the plane has registered the (re-pointed) local source. This resends
 * the webhook after a grace window until a run appears or the timeout elapses.
 */

import { randomUUID } from 'node:crypto';
import { AdminApiClient } from '@kici-dev/orchestrator';

/** A minimal admin-read client (AdminApiClient.get) — injectable for tests. */
export interface RunDiscoveryClient {
  get<T>(path: string): Promise<T>;
}

export interface LocalTriggerInput {
  orgId: string;
  sourceId: string;
  repoFullName: string;
  event: 'push' | 'pull_request' | 'dispatch';
  ref: string;
  sha: string;
  defaultBranch: string;
  /**
   * Dispatch event action (`dispatch()` `types` matcher key). Only used when
   * `event === 'dispatch'`; the local normalizer reads it from `payload.action`,
   * so exactly one `types`-filtered workflow matches.
   */
  action?: string;
  /** Dispatch `client_payload` (steps read `ctx.rawPayload.client_payload`). */
  clientPayload?: unknown;
}

export interface LocalTriggerRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Build the GitHub-shaped webhook request the plane's local provider normalizer
 * expects. Mirrors `buildLocalTriggerRequest` in the orchestrator's
 * `cli/commands/local-trigger.ts` (kept local to honour the compiler-only scope
 * of this phase — no orchestrator export is added).
 */
export function buildLocalTriggerRequest(input: LocalTriggerInput): LocalTriggerRequest {
  // A dispatch event carries `action` (the `types` matcher key) + `client_payload`
  // alongside the GitHub-shaped ref/repository fields (kept for run provenance).
  // The local normalizer reads `payload.action`, so a single `types`-filtered
  // workflow matches. Push/PR events omit the dispatch-only fields.
  const body = JSON.stringify({
    ref: input.ref,
    after: input.sha,
    repository: { full_name: input.repoFullName, default_branch: input.defaultBranch },
    ...(input.event === 'dispatch' && {
      action: input.action,
      client_payload: input.clientPayload ?? {},
    }),
  });
  return {
    path: `/webhook/${input.orgId}/generic/${input.sourceId}`,
    headers: {
      'content-type': 'application/json',
      'x-event-type': input.event,
      'x-delivery-id': randomUUID(),
    },
    body,
  };
}

/** Structured result of posting a local trigger to the plane. */
export interface LocalTriggerResponse {
  status: number;
  /** Routing-key-scoped delivery id echoed by the plane, or null if absent. */
  deliveryId: string | null;
}

/** POST the trigger request to the plane. Returns the status + delivery id. */
export async function sendLocalTrigger(
  planeUrl: string,
  req: LocalTriggerRequest,
): Promise<LocalTriggerResponse> {
  const res = await fetch(`${planeUrl.replace(/\/$/, '')}${req.path}`, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
  });
  let deliveryId: string | null = null;
  try {
    const parsed = (await res.json()) as { deliveryId?: unknown };
    if (typeof parsed.deliveryId === 'string') deliveryId = parsed.deliveryId;
  } catch {
    // Non-JSON / bodyless response (e.g. a pre-registration 404) — no delivery id.
  }
  return { status: res.status, deliveryId };
}

interface RunsListResponse {
  runs: Array<{ runId: string }>;
}

export interface TriggerRunOptions {
  client?: RunDiscoveryClient;
  pollIntervalMs?: number;
  resendAfterMs?: number;
  timeoutMs?: number;
}

/**
 * Trigger the run and resolve its runId. Sends the synthetic push, then polls
 * the admin runs list filtered by this webhook's routing-key-scoped delivery id
 * (`?deliveryId=`), resending the webhook past a grace window to absorb source
 * hot-reload latency. Correlating on the exact delivery id — rather than the
 * newest run in a time window — guarantees the follower attaches to the run
 * THIS invocation created, even when another local run lands concurrently.
 */
export async function triggerRun(
  planeUrl: string,
  adminToken: string,
  input: LocalTriggerInput,
  opts: TriggerRunOptions = {},
): Promise<string> {
  const client: RunDiscoveryClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const resendAfterMs = opts.resendAfterMs ?? 8_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const req = buildLocalTriggerRequest(input);
  // The delivery id correlates the created run to THIS webhook. It is stable
  // across resends (same x-delivery-id) and routing-key-scoped by the plane, so
  // the client learns it only from the response body. Poll by it exactly — no
  // "newest since" window, which would re-introduce the clock-skew collision.
  let deliveryId = (await sendLocalTrigger(planeUrl, req)).deliveryId;

  let lastSend = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deliveryId) {
      const runId = await findRunByDelivery(client, deliveryId);
      if (runId) return runId;
    }
    if (Date.now() - lastSend > resendAfterMs) {
      // Resend absorbs the source hot-reload debounce; capture the delivery id
      // if the first send happened before the source was registered.
      deliveryId ??= (await sendLocalTrigger(planeUrl, req)).deliveryId;
      lastSend = Date.now();
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('offline run: no run appeared after triggering the local plane');
}

/** Return the run created by this webhook delivery, or null when none yet. */
async function findRunByDelivery(
  client: RunDiscoveryClient,
  deliveryId: string,
): Promise<string | null> {
  const qs = new URLSearchParams({ deliveryId, limit: '1' });
  const { runs } = await client.get<RunsListResponse>(`/api/v1/admin/runs?${qs}`);
  return runs[0]?.runId ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
