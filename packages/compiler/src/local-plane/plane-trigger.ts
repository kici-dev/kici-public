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

/** POST the trigger request to the plane. Returns the HTTP status. */
export async function sendLocalTrigger(
  planeUrl: string,
  req: LocalTriggerRequest,
): Promise<number> {
  const res = await fetch(`${planeUrl.replace(/\/$/, '')}${req.path}`, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
  });
  return res.status;
}

interface RunsListResponse {
  runs: Array<{ runId: string; createdAt: string }>;
}

export interface TriggerRunOptions {
  client?: RunDiscoveryClient;
  pollIntervalMs?: number;
  resendAfterMs?: number;
  timeoutMs?: number;
}

/**
 * Trigger the run and resolve its runId. Sends the synthetic push, then polls
 * the admin runs list (`created_at > since`) for the newest run, resending the
 * webhook past a grace window to absorb source hot-reload latency.
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

  const since = new Date(Date.now() - 3_000);
  const req = buildLocalTriggerRequest(input);
  await sendLocalTrigger(planeUrl, req);

  let lastSend = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runId = await findLatestRunSince(client, since);
    if (runId) return runId;
    if (Date.now() - lastSend > resendAfterMs) {
      await sendLocalTrigger(planeUrl, req);
      lastSend = Date.now();
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('offline run: no run appeared after triggering the local plane');
}

/** Return the newest run created after `since`, or null when none yet. */
async function findLatestRunSince(
  client: RunDiscoveryClient,
  since: Date,
): Promise<string | null> {
  const qs = new URLSearchParams({ since: since.toISOString(), limit: '5' });
  const { runs } = await client.get<RunsListResponse>(`/api/v1/admin/runs?${qs}`);
  // The list is ordered created_at desc, so runs[0] is the newest match.
  return runs[0]?.runId ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
