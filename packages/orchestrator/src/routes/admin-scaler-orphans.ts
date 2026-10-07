/**
 * Live orphaned Firecracker VM admin routes, behind `kici-admin scaler orphans`.
 *
 * Mounted inside `createAdminRoutes` at `/api/v1/admin`, so the Bearer-token
 * auth middleware has already resolved the caller's role. Both routes need an
 * unscoped token: a VM belongs to a host, not to one routing key.
 *
 * - `GET  /api/v1/admin/scaler/orphans?target=<instance-id>&timeoutMs=<n>` —
 *   every live Firecracker VM on the node, with how it is tracked
 *   (`scaler.read`).
 * - `POST /api/v1/admin/scaler/orphans/stop { target?, vmIds, timeoutMs? }` —
 *   stop the approved VMs nothing tracks (`scaler.manage`).
 *
 * The node is this coordinator, or the peer `target` names, reached over the
 * authenticated peer channel. The coordinator adds the one tracker only it
 * can answer — a non-terminal job in its dispatch queue bound to the VM's
 * agent — and never forwards a bound VM to the node's stop.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogSource,
  AccessLogTargetType,
  ActorType,
  ScalerOrphansAction,
  ScalerVmStatus,
  ScalerVmStopOutcome,
  ScalerVmTracker,
  type PeerScalerOrphansResponse,
  type ScalerLiveVm,
  type ScalerVmStopResult,
} from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import {
  MAX_SCALER_ORPHANS_TIMEOUT_MS,
  type ScalerOrphansAnswer,
  type ScalerOrphansRequest,
} from '../scaler/orphan-requests.js';
import { ScalerOrphansForwardFailure } from '../cluster/scaler-orphans-peer.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-scaler-orphans' });

/** What the routes need from the coordinator they run on. */
export interface ScalerOrphansRouteDeps {
  /** This coordinator's instance id. */
  instanceId: string;
  role: 'coordinator' | 'worker';
  /** The cluster role a connected peer registered with, if known. */
  peerRole: (instanceId: string) => 'coordinator' | 'worker' | undefined;
  /** Answer from this coordinator's own host and tracking. */
  answerLocal: (req: ScalerOrphansRequest) => Promise<ScalerOrphansAnswer>;
  /** Forward to a peer over the peer channel. */
  forward: (
    target: string,
    req: ScalerOrphansRequest,
    timeoutMs: number,
  ) => Promise<PeerScalerOrphansResponse | ScalerOrphansForwardFailure>;
  /** Non-terminal dispatch-queue jobs bound to these agent ids, keyed by agent id. */
  findBindings: (agentIds: string[]) => Promise<Map<string, string>>;
  /**
   * The cluster instance each of these agent ids is registered with — this
   * coordinator or a peer whose heartbeat lists it — keyed by agent id. An
   * agent can register with an HA sibling of the node that runs its VM.
   */
  findRegistrations: (agentIds: string[]) => Map<string, string>;
  /**
   * The coordinator peers this cluster expects but has no live link to. Their
   * registered agents are unknown, so while any is missing no VM can be shown
   * to be untracked.
   */
  disconnectedCoordinators: () => string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const timeoutMsSchema = z.coerce.number().int().min(1_000).max(MAX_SCALER_ORPHANS_TIMEOUT_MS);
const targetSchema = z.string().trim().min(1).max(256);

const listQuerySchema = z.object({
  target: targetSchema.optional(),
  timeoutMs: timeoutMsSchema.default(DEFAULT_TIMEOUT_MS),
});

const stopBodySchema = z.object({
  target: targetSchema.optional(),
  vmIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  timeoutMs: timeoutMsSchema.default(DEFAULT_TIMEOUT_MS),
});

/** The node a request addresses. */
interface ResolvedNode {
  instanceId: string;
  role: 'coordinator' | 'worker' | 'unknown';
  local: boolean;
}

/** A node answer, or the HTTP error that replaces it. */
type NodeOutcome =
  { ok: true; answer: ScalerOrphansAnswer } | { ok: false; status: 404 | 502 | 504; error: string };

function resolveNode(deps: ScalerOrphansRouteDeps, target: string | undefined): ResolvedNode {
  if (target === undefined || target === deps.instanceId) {
    return { instanceId: deps.instanceId, role: deps.role, local: true };
  }
  return { instanceId: target, role: deps.peerRole(target) ?? 'unknown', local: false };
}

async function askNode(
  deps: ScalerOrphansRouteDeps,
  node: ResolvedNode,
  req: ScalerOrphansRequest,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const answer = node.local
    ? await deps.answerLocal(req)
    : await deps.forward(node.instanceId, req, timeoutMs);
  if (answer === ScalerOrphansForwardFailure.enum['not-connected']) {
    return {
      ok: false,
      status: 404,
      error: `peer ${node.instanceId} is not connected to this coordinator`,
    };
  }
  if (answer === ScalerOrphansForwardFailure.enum.timeout) {
    return {
      ok: false,
      status: 504,
      error:
        `peer ${node.instanceId} did not answer within ${timeoutMs} ms; ` +
        'it may run a version without this request',
    };
  }
  if (!answer.ok) {
    return { ok: false, status: 502, error: answer.error ?? 'the node answered with an error' };
  }
  return { ok: true, answer };
}

/** What this coordinator alone can see tracking one VM. */
interface CoordinatorTracking {
  trackers: ScalerVmTracker[];
  detail: string;
}

/**
 * The trackers only this coordinator can answer for: a non-terminal job in its
 * dispatch queue bound to the VM's agent, and the agent registered with this
 * coordinator or with a peer. A VM in the map is tracked, whatever its node says.
 */
async function coordinatorTracking(
  deps: ScalerOrphansRouteDeps,
  vmIds: string[],
): Promise<Map<string, CoordinatorTracking>> {
  const tracking = new Map<string, CoordinatorTracking>();
  if (vmIds.length === 0) return tracking;
  const bindings = await deps.findBindings(vmIds);
  const registrations = deps.findRegistrations(vmIds);
  for (const vmId of vmIds) {
    const trackers: ScalerVmTracker[] = [];
    const details: string[] = [];
    const instance = registrations.get(vmId);
    if (instance !== undefined) {
      trackers.push(ScalerVmTracker.enum.registered);
      details.push(`agent registered with ${instance}`);
    }
    const jobId = bindings.get(vmId);
    if (jobId !== undefined) {
      trackers.push(ScalerVmTracker.enum['bound-job']);
      details.push(`bound to job ${jobId}`);
    }
    if (trackers.length > 0) tracking.set(vmId, { trackers, detail: details.join('; ') });
  }
  return tracking;
}

/** Why no VM can be an orphan while `missing` coordinators are unreachable. */
function missingCoordinatorsReason(missing: string[]): string {
  return (
    `coordinator peer(s) ${missing.join(', ')} not connected: an agent registered with ` +
    'them cannot be ruled out, so the VM is not stopped until they reconnect'
  );
}

/** Downgrade every orphaned VM to unverified while coordinators are missing. */
function downgradeOrphans(vms: ScalerLiveVm[], missing: string[]): ScalerLiveVm[] {
  if (missing.length === 0) return vms;
  return vms.map((vm) =>
    vm.status === ScalerVmStatus.enum.orphaned
      ? {
          ...vm,
          status: ScalerVmStatus.enum.unverified,
          reason: missingCoordinatorsReason(missing),
        }
      : vm,
  );
}

/** Mark every VM the coordinator sees tracked as tracked, naming why. */
function overlayTracking(
  vms: ScalerLiveVm[],
  tracking: Map<string, CoordinatorTracking>,
): ScalerLiveVm[] {
  return vms.map((vm) => {
    const seen = tracking.get(vm.vmId);
    if (seen === undefined) return vm;
    const trackedBy = [...new Set([...vm.trackedBy, ...seen.trackers])];
    return {
      ...vm,
      status: ScalerVmStatus.enum.tracked,
      trackedBy,
      reason: `tracked: ${trackedBy.join(', ')}; ${seen.detail}`,
    };
  });
}

function countOutcomes(results: ScalerVmStopResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return counts;
}

export function createScalerOrphansRoutes(deps: {
  orphans: ScalerOrphansRouteDeps;
  rbac: RbacEnforcer;
  accessLog?: AccessLogWriter;
}): Hono<AdminEnv> {
  const app = createAdminApp(logger);
  const { orphans } = deps;

  /** One access_log row; best effort, never gating the response. */
  const audit = async (
    c: Context<AdminEnv>,
    action: AccessLogAction,
    nodeId: string,
    outcome: { error?: string; meta?: Record<string, unknown> },
  ): Promise<void> => {
    await deps.accessLog?.record({
      orgId: null,
      routingKey: null,
      actor: { type: ActorType.enum.service_account, id: c.get('userId') },
      action,
      target: { type: AccessLogTargetType.enum.scaler, id: nodeId },
      requestId: null,
      source: AccessLogSource.enum.admin_http,
      outcome:
        outcome.error === undefined ? AccessLogOutcome.enum.allowed : AccessLogOutcome.enum.error,
      ...(outcome.error !== undefined ? { errorMessage: outcome.error } : {}),
      ...(outcome.meta ? { meta: outcome.meta } : {}),
    });
  };

  app.get('/scaler/orphans', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'scaler.read');
    const query = listQuerySchema.safeParse({
      target: c.req.query('target'),
      timeoutMs: c.req.query('timeoutMs'),
    });
    if (!query.success) {
      return c.json({ error: 'Validation error', details: query.error.issues }, 400);
    }
    const node = resolveNode(orphans, query.data.target);
    const outcome = await askNode(
      orphans,
      node,
      { action: ScalerOrphansAction.enum.list },
      query.data.timeoutMs,
    );
    if (!outcome.ok) {
      await audit(c, AccessLogAction.enum['scaler.orphans.read'], node.instanceId, {
        error: outcome.error,
      });
      return c.json({ error: outcome.error }, outcome.status);
    }
    const vms = outcome.answer.vms ?? [];
    const tracking = await coordinatorTracking(
      orphans,
      vms.map((vm) => vm.vmId),
    );
    const missing = orphans.disconnectedCoordinators();
    await audit(c, AccessLogAction.enum['scaler.orphans.read'], node.instanceId, {});
    return c.json({
      node: {
        instanceId: node.instanceId,
        role: node.role,
        firecrackerScalers: outcome.answer.firecrackerScalers ?? [],
        disconnectedCoordinators: missing,
      },
      vms: downgradeOrphans(overlayTracking(vms, tracking), missing),
    });
  });

  app.post('/scaler/orphans/stop', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'scaler.manage');
    const body = stopBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'Validation error', details: body.error.issues }, 400);
    }
    const node = resolveNode(orphans, body.data.target);
    const vmIds = [...new Set(body.data.vmIds)];
    logger.info('Scaler orphan stop requested', {
      target: node.instanceId,
      vmIds,
      actor: c.get('userId'),
    });

    // A VM whose agent holds a live job, or is registered anywhere in the
    // cluster, is tracked whatever its node says: it never reaches the node's stop.
    const tracking = await coordinatorTracking(orphans, vmIds);
    // While a coordinator peer is unreachable, an agent registered with it
    // cannot be ruled out: no VM is an orphan, and none reaches the node.
    const missing = orphans.disconnectedCoordinators();
    const unbound = missing.length > 0 ? [] : vmIds.filter((vmId) => !tracking.has(vmId));
    let nodeResults: ScalerVmStopResult[] = [];
    let firecrackerScalers: string[] = [];
    if (unbound.length > 0) {
      const outcome = await askNode(
        orphans,
        node,
        { action: ScalerOrphansAction.enum.stop, vmIds: unbound },
        body.data.timeoutMs,
      );
      if (!outcome.ok) {
        logger.warn('Scaler orphan stop failed', {
          target: node.instanceId,
          status: outcome.status,
          error: outcome.error,
        });
        await audit(c, AccessLogAction.enum['scaler.orphan.stop'], node.instanceId, {
          error: outcome.error,
          meta: { target: node.instanceId, vm_ids: vmIds },
        });
        return c.json({ error: outcome.error }, outcome.status);
      }
      nodeResults = outcome.answer.results ?? [];
      firecrackerScalers = outcome.answer.firecrackerScalers ?? [];
    }

    const byId = new Map(nodeResults.map((result) => [result.vmId, result]));
    const results: ScalerVmStopResult[] = vmIds.map((vmId) => {
      const seen = tracking.get(vmId);
      if (seen !== undefined) {
        return { vmId, outcome: ScalerVmStopOutcome.enum.tracked, detail: seen.detail };
      }
      if (missing.length > 0) {
        return {
          vmId,
          outcome: ScalerVmStopOutcome.enum.unverified,
          detail: missingCoordinatorsReason(missing),
        };
      }
      return (
        byId.get(vmId) ?? {
          vmId,
          outcome: ScalerVmStopOutcome.enum.error,
          detail: 'the node returned no result for this VM',
        }
      );
    });

    logger.info('Scaler orphan stop finished', {
      target: node.instanceId,
      outcomes: countOutcomes(results),
    });
    await audit(c, AccessLogAction.enum['scaler.orphan.stop'], node.instanceId, {
      meta: { target: node.instanceId, vm_ids: vmIds, results },
    });
    return c.json({
      node: {
        instanceId: node.instanceId,
        role: node.role,
        firecrackerScalers,
        disconnectedCoordinators: missing,
      },
      results,
    });
  });

  return app;
}
