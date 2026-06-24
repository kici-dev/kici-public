/**
 * Dashboard fleet host-write handler for the orchestrator.
 *
 * Responds to the two Model C fleet write messages from Platform —
 * `dashboard.fleet.host.declare` and `dashboard.fleet.host.remove` — by
 * enforcing the per-org dashboard-write policy, calling the host roster store,
 * writing a `platform_proxy` access-log row, and sending a typed response.
 *
 * Mirrors `DashboardBackendsHandler`: a policy gate (`enforcePolicy`) that
 * short-circuits a disabled op with a structured `operation_disabled` envelope
 * plus a `denied` access-log row, and a `recordAccess` helper that attributes
 * every outcome to the calling actor.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
  FleetHostDeclareRequest,
  FleetHostRemoveRequest,
} from '@kici-dev/engine';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { HostRosterStore } from '../agent/host-roster.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-fleet-write-handler' });

interface DashboardFleetWriteHandlerDeps {
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  /** The orchestrator host roster store (declare / remove). */
  rosterStore: HostRosterStore;
  /** Database — required for dashboard-write policy lookups. */
  db: Kysely<Database>;
  /** Access log writer — records one row per mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Org ID for access_log rows (null when the orchestrator isn't org-scoped). */
  orgId?: string | null;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
}

/** Messages this handler owns. */
type FleetWriteMessage = FleetHostDeclareRequest | FleetHostRemoveRequest;

/**
 * Handler for the fleet host-write WS messages. Dispatches by type and calls
 * the host roster store behind the dashboard-write policy gate.
 */
export class DashboardFleetWriteHandler {
  private readonly deps: DashboardFleetWriteHandlerDeps;
  private orgId: string | null;
  private routingKey: string | null;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardFleetWriteHandlerDeps) {
    this.deps = deps;
    this.orgId = deps.orgId ?? null;
    this.routingKey = deps.routingKey ?? null;
    this.accessLog = deps.accessLog;
  }

  /**
   * Update the bound orgId + routingKey. Called from server.ts after resolving
   * the single tenant org from the `sources` / `generic_webhook_sources` table.
   */
  setOrgContext(orgId: string | null, routingKey: string | null): void {
    this.orgId = orgId;
    this.routingKey = routingKey;
  }

  /**
   * Defense-in-depth dashboard-write policy gate. Returns true when the
   * operation is allowed and the caller should proceed. Returns false when the
   * policy is disabled — also records a `denied` access_log row and emits a
   * structured `operation_disabled` envelope on the WS.
   *
   * Fails open when no org is bound — the orch hasn't resolved a customer yet.
   */
  private async enforcePolicy(
    msg: { actor: ActorPrincipal; requestId: string },
    op: DashboardWriteOperation,
    responseType: string,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
  ): Promise<boolean> {
    if (!this.orgId) return true;
    try {
      await assertDashboardWriteAllowed(this.deps.db, this.orgId, op);
      return true;
    } catch (err) {
      if (err instanceof DashboardWritePolicyDisabledError) {
        this.recordAccess(
          msg.actor,
          action,
          target,
          msg.requestId,
          'denied',
          `operation_disabled:${err.operation}`,
        );
        this.deps.send(buildPolicyDeniedResponse(op, responseType, msg.requestId));
        return false;
      }
      throw err;
    }
  }

  /**
   * Write an access_log row for a handler invocation. Best-effort; the writer
   * swallows failures.
   */
  private recordAccess(
    actor: ActorPrincipal,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
    requestId: string | null,
    outcome: AccessLogOutcome,
    errorMessage?: string | null,
  ): void {
    if (!this.accessLog) return;
    void this.accessLog.record({
      orgId: this.orgId,
      routingKey: this.routingKey,
      actor,
      action,
      target,
      requestId,
      source: 'platform_proxy',
      outcome,
      errorMessage: errorMessage ?? null,
    });
  }

  /**
   * Route a fleet host-write message to the appropriate handler. Returns true
   * if the message was handled, false otherwise.
   */
  async handleMessage(msg: FleetWriteMessage): Promise<boolean> {
    switch (msg.type) {
      case 'dashboard.fleet.host.declare':
        await this.handleDeclare(msg);
        return true;
      case 'dashboard.fleet.host.remove':
        await this.handleRemove(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleDeclare(msg: FleetHostDeclareRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'fleet.host.declare',
        'dashboard.fleet.host.declare.response',
        'fleet.host.declare',
        { type: 'fleet', id: msg.agentId },
      ))
    ) {
      return;
    }
    try {
      await this.deps.rosterStore.declareStatic({
        agentId: msg.agentId,
        labels: msg.labels,
        hostname: msg.hostname,
        properties: msg.properties,
      });
      this.recordAccess(
        msg.actor,
        'fleet.host.declare',
        { type: 'fleet', id: msg.agentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.fleet.host.declare.response',
        requestId: msg.requestId,
        declared: true,
      });
    } catch (err) {
      logger.error('Failed to declare host', { agentId: msg.agentId, error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'fleet.host.declare',
        { type: 'fleet', id: msg.agentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.fleet.host.declare.response',
        requestId: msg.requestId,
        error: `Failed to declare host: ${toErrorMessage(err)}`,
      });
    }
  }

  private async handleRemove(msg: FleetHostRemoveRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'fleet.host.remove',
        'dashboard.fleet.host.remove.response',
        'fleet.host.remove',
        { type: 'fleet', id: msg.agentId },
      ))
    ) {
      return;
    }
    try {
      const deleted = await this.deps.rosterStore.removeStatic(msg.agentId);
      this.recordAccess(
        msg.actor,
        'fleet.host.remove',
        { type: 'fleet', id: msg.agentId },
        msg.requestId,
        'allowed',
      );
      // `removed: false` is the not-found sentinel (no `error`) so the Platform
      // route can serve a structured 404 instead of a 500.
      this.deps.send({
        type: 'dashboard.fleet.host.remove.response',
        requestId: msg.requestId,
        removed: deleted > 0,
      });
    } catch (err) {
      logger.error('Failed to remove host', { agentId: msg.agentId, error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'fleet.host.remove',
        { type: 'fleet', id: msg.agentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.fleet.host.remove.response',
        requestId: msg.requestId,
        error: `Failed to remove host: ${toErrorMessage(err)}`,
      });
    }
  }
}
