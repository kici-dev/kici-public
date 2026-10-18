/**
 * Trigger an offline routed run against the local plane and discover its runs:
 * one per matched workflow, as for any webhook.
 *
 * A local repo has no forge, so this posts a GitHub-shaped synthetic push to the
 * plane's generic webhook route (the wire shape `kici-admin source trigger-local`
 * builds). The webhook is unauthenticated (202) and the run is created
 * asynchronously, so this polls the admin runs list with the plane's bootstrap
 * admin token.
 *
 * The source's bundle hot-reload is debounced, so a first trigger can land before
 * the plane registers the (re-pointed) local source; while no delivery id has
 * come back, this resends after a grace window until the timeout. A timeout is
 * explained from the plane's Raft role and its event-log record for the delivery.
 */

import { randomUUID } from 'node:crypto';
import { AdminApiClient } from '@kici-dev/orchestrator';
import { EventLogStatus, sleep } from '@kici-dev/engine';

/** AdminApiClient.get subset, injectable for tests. */
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
  /**
   * Commit before the run's snapshot: changed files are `before..sha`; without
   * it the push has no range.
   */
  before?: string;
  defaultBranch: string;
  /**
   * `dispatch()` `types` matcher key, used only when `event === 'dispatch'`; the
   * local normalizer reads `payload.action`, so exactly one `types`-filtered
   * workflow matches.
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
 * Mirrors `buildLocalTriggerRequest` in the orchestrator's
 * `cli/commands/local-trigger.ts`, kept local so the compiler imports no
 * orchestrator export for it.
 */
export function buildLocalTriggerRequest(input: LocalTriggerInput): LocalTriggerRequest {
  // Dispatch adds `action` (the `types` matcher key the local normalizer reads from
  // `payload.action`, so a `types`-filtered workflow matches) + `client_payload`;
  // the ref/repository fields stay for run provenance.
  const body = JSON.stringify({
    ref: input.ref,
    ...(input.before && { before: input.before }),
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

export interface LocalTriggerResponse {
  status: number;
  /** Routing-key-scoped delivery id echoed by the plane. */
  deliveryId: string | null;
}

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
    // Bodyless response (e.g. a pre-registration 404).
  }
  return { status: res.status, deliveryId };
}

interface RunsListResponse {
  runs: Array<{ runId: string; workflowName?: string }>;
}

/** One run the local trigger created, and the workflow it executes. */
export interface LocalTriggeredRun {
  runId: string;
  workflowName?: string;
}

const MAX_RUNS_PER_DELIVERY = 100;

export interface TriggerRunOptions {
  client?: RunDiscoveryClient;
  pollIntervalMs?: number;
  resendAfterMs?: number;
  timeoutMs?: number;
  /** Named in the lock-file diagnosis. */
  repoBasePath?: string;
  /** Plane log path, named when nothing else explains the timeout. */
  logPath?: string;
  /** Wait for more runs once the delivery is recorded. Default 5 s. */
  settleMs?: number;
}

interface ClusterHealthResponse {
  /** 'follower' | 'candidate' | 'leader'. */
  role?: string;
}

interface EventLogListResponse {
  deliveries?: Array<{
    status?: string;
    errorMessage?: string | null;
    /** The runs the delivery created, once it is `processed`. */
    matchedCount?: number | null;
  }>;
}

export interface TriggerTimeoutContext {
  /** Null when the plane never accepted the webhook. */
  deliveryId: string | null;
  orgId: string;
  /** The workdir's overlay commit. */
  sha: string;
  /** Absolute path the plane's local source points at — the run's workdir. */
  repoBasePath?: string;
  logPath?: string;
}

/** Null when `/cluster/health` cannot be read. */
async function readPlaneRole(client: RunDiscoveryClient): Promise<string | null> {
  try {
    const health = await client.get<ClusterHealthResponse>('/cluster/health');
    return typeof health.role === 'string' ? health.role : null;
  } catch {
    // The diagnosis must never mask the timeout it is explaining.
    return null;
  }
}

/** The delivery's event-log row; null when none is recorded yet, undefined when unreadable. */
async function readDelivery(
  client: RunDiscoveryClient,
  orgId: string,
  deliveryId: string,
): Promise<
  { status?: string; errorMessage?: string | null; matchedCount?: number | null } | null | undefined
> {
  try {
    const qs = new URLSearchParams({ deliveryId, orgId, limit: '1' });
    const res = await client.get<EventLogListResponse>(`/api/v1/admin/event-log?${qs}`);
    return res.deliveries?.[0] ?? null;
  } catch {
    return undefined;
  }
}

/**
 * Explain a trigger timeout in one line, most specific first, from facts the
 * plane recorded rather than inference: its Raft role, then the status it wrote
 * for THIS delivery, then the delivery id + log path as a last thread to pull.
 */
export async function diagnoseTriggerTimeout(
  client: RunDiscoveryClient,
  ctx: TriggerTimeoutContext,
): Promise<string> {
  const role = await readPlaneRole(client);
  if (role !== null && role !== 'leader') {
    return (
      `plane is not leader yet (election grace period) — it reports Raft role "${role}". ` +
      `A single-node plane should elect itself within seconds; ` +
      `check ${ctx.logPath ?? 'the plane log (\`kici local logs\`)'} for "self-electing as leader".`
    );
  }

  const delivery = ctx.deliveryId ? await readDelivery(client, ctx.orgId, ctx.deliveryId) : null;
  if (delivery?.status === EventLogStatus.enum.lockfile_missing) {
    const where = ctx.repoBasePath ? ` in ${ctx.repoBasePath}` : '';
    return (
      `no kici.lock.json at ${ctx.sha}${where} — the plane resolved no lock file for this ` +
      `commit, so nothing matched. Make sure .kici/kici.lock.json is committed or present in ` +
      `the working tree the run packs.`
    );
  }
  if (delivery?.status) {
    const detail = delivery.errorMessage ? ` (${delivery.errorMessage})` : '';
    return (
      `the plane recorded delivery ${ctx.deliveryId} as "${delivery.status}"${detail} ` +
      `but created no run.`
    );
  }

  const which = ctx.deliveryId
    ? `delivery ${ctx.deliveryId}`
    : 'this trigger — the plane never accepted the webhook (no delivery id came back)';
  const log = ctx.logPath ? ` — see ${ctx.logPath}` : '';
  return `no run appeared for ${which}${log}`;
}

/**
 * Send the synthetic push, then poll the admin runs list by this webhook's
 * delivery id (`?deliveryId=`). Correlating on the exact delivery id, not the
 * newest run in a time window, attaches the follower to the runs THIS
 * invocation created even when another local run lands concurrently.
 * The set is complete once the plane records the delivery `processed` with
 * that many matched runs, or `settleMs` after the first run appears.
 */
export async function triggerRuns(
  planeUrl: string,
  adminToken: string,
  input: LocalTriggerInput,
  opts: TriggerRunOptions = {},
): Promise<LocalTriggeredRun[]> {
  const client: RunDiscoveryClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const resendAfterMs = opts.resendAfterMs ?? 8_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const settleMs = opts.settleMs ?? 5_000;

  const req = buildLocalTriggerRequest(input);
  // Stable across resends (same x-delivery-id) and routing-key-scoped by the
  // plane, so the client learns it only from the response body. A "newest since"
  // window would re-introduce the clock-skew collision.
  let deliveryId = (await sendLocalTrigger(planeUrl, req)).deliveryId;

  let lastSend = Date.now();
  let found: LocalTriggeredRun[] = [];
  // Since the plane recorded the delivery (or its event log could not be read).
  let settlingSince: number | undefined;
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deliveryId) {
      const runs = await findRunsByDelivery(client, deliveryId);
      if (runs.length > 0) {
        if (found.length === 0) deadline = Date.now() + timeoutMs;
        found = runs;
        // fails-when: the follower attaches to the first run while later workflows' runs go
        // unwatched
        // breaks-if-wrong: a delivery the plane recorded with one matched run returns at once
        const delivery = await readDelivery(client, input.orgId, deliveryId);
        if (
          delivery?.status === EventLogStatus.enum.processed &&
          typeof delivery.matchedCount === 'number' &&
          runs.length >= delivery.matchedCount
        ) {
          return runs;
        }
        // The plane records a delivery once, after its last workflow: until then
        // (no row) more runs can appear, so only a recorded or unreadable one settles.
        if (delivery !== null) settlingSince ??= Date.now();
        if (settlingSince !== undefined && Date.now() - settlingSince >= settleMs) return runs;
      }
    }
    if (Date.now() - lastSend > resendAfterMs) {
      // Resends only while no delivery id came back (a send before the source
      // registered), absorbing the hot-reload debounce.
      deliveryId ??= (await sendLocalTrigger(planeUrl, req)).deliveryId;
      lastSend = Date.now();
    }
    await sleep(pollIntervalMs);
  }
  if (found.length > 0) return found;
  const cause = await diagnoseTriggerTimeout(client, {
    deliveryId,
    orgId: input.orgId,
    sha: input.sha,
    ...(opts.repoBasePath !== undefined && { repoBasePath: opts.repoBasePath }),
    ...(opts.logPath !== undefined && { logPath: opts.logPath }),
  });
  throw new Error(`offline run: ${cause}`);
}

/** The delivery's runs, oldest first: the order the plane dispatched the workflows in. */
async function findRunsByDelivery(
  client: RunDiscoveryClient,
  deliveryId: string,
): Promise<LocalTriggeredRun[]> {
  const qs = new URLSearchParams({ deliveryId, limit: String(MAX_RUNS_PER_DELIVERY) });
  const { runs } = await client.get<RunsListResponse>(`/api/v1/admin/runs?${qs}`);
  return runs
    .map((r) => ({ runId: r.runId, ...(r.workflowName && { workflowName: r.workflowName }) }))
    .reverse();
}
