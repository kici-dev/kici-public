/**
 * Handles the Model C fleet writes `dashboard.fleet.host.declare` and
 * `dashboard.fleet.host.remove` behind the per-org dashboard-write policy,
 * writing a `platform_proxy` access-log row per outcome. Mirrors
 * `DashboardBackendsHandler`: a disabled op short-circuits with an
 * `operation_disabled` envelope plus a `denied` row, and
 * `DashboardAccessRecorder` attributes every outcome to the calling actor.
 *
 * The handler never passes a write authority, so the roster store applies the
 * Platform's: a declare only creates a new, unconfirmed host, a remove only
 * deletes such a host, and reserved `kici:` labels and properties are refused.
 * A refusal records a `denied` row and answers with a `FleetHostWriteRefusal` code.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogTargetType,
  ActorPrincipal,
  FleetHostDeclareRequest,
  FleetHostRemoveRequest,
} from '@kici-dev/engine';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  type HostRosterStore,
  HostWriteRefusedError,
  ReservedHostKeyError,
} from '../agent/host-roster.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';
import { DashboardAccessRecorder } from './dashboard-access.js';

const logger = createLogger({ prefix: 'dashboard-fleet-write-handler' });

interface DashboardFleetWriteHandlerDeps {
  send: (msg: unknown) => void;
  rosterStore: HostRosterStore;
  /** For dashboard-write policy lookups. */
  db: Kysely<Database>;
  accessLog?: AccessLogWriter;
  /** Org ID for access_log rows (null when the orchestrator isn't org-scoped). */
  orgId?: string | null;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
}

type FleetWriteMessage = FleetHostDeclareRequest | FleetHostRemoveRequest;

export class DashboardFleetWriteHandler {
  private readonly deps: DashboardFleetWriteHandlerDeps;
  private orgId: string | null;
  private routingKey: string | null;
  private readonly access: DashboardAccessRecorder;

  constructor(deps: DashboardFleetWriteHandlerDeps) {
    this.deps = deps;
    this.orgId = deps.orgId ?? null;
    this.routingKey = deps.routingKey ?? null;
    this.access = new DashboardAccessRecorder(
      deps.accessLog,
      () => ({ orgId: this.orgId, routingKey: this.routingKey }),
      logger,
    );
  }

  /**
   * Called from server.ts once the single tenant org resolves from the
   * `sources`, `generic_webhook_sources` or `remote_sources` table.
   */
  setOrgContext(orgId: string | null, routingKey: string | null): void {
    this.orgId = orgId;
    this.routingKey = routingKey;
  }

  /**
   * Defense-in-depth policy gate: false when the policy disables the op, after
   * recording a `denied` row and sending the `operation_disabled` envelope.
   * Fails open when no org is bound (no customer resolved yet).
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
        this.access.record(
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
   * Answer a write the roster store refused for the Platform's authority: a
   * `denied` access-log row with `<code>:<detail>`, and the refusal code in the
   * response `error` field (plus the reserved keys for `reserved_property`).
   */
  private refuse(
    msg: { actor: ActorPrincipal; requestId: string; agentId: string },
    action: AccessLogAction,
    responseType: string,
    err: HostWriteRefusedError,
  ): void {
    this.access.record(
      msg.actor,
      action,
      { type: 'fleet', id: msg.agentId },
      msg.requestId,
      'denied',
      `${err.code}:${err.detail}`,
    );
    this.deps.send({
      type: responseType,
      requestId: msg.requestId,
      error: err.code,
      ...(err instanceof ReservedHostKeyError && { reservedKeys: err.keys }),
    });
  }

  /** Returns false for a message this handler does not own. */
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
      // No authority: the store's Platform default applies (see the header).
      const { created } = await this.deps.rosterStore.declareStatic({
        agentId: msg.agentId,
        labels: msg.labels,
        hostname: msg.hostname,
        properties: msg.properties,
      });
      this.access.record(
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
        created,
      });
    } catch (err) {
      if (err instanceof HostWriteRefusedError) {
        this.refuse(msg, 'fleet.host.declare', 'dashboard.fleet.host.declare.response', err);
        return;
      }
      logger.error('Failed to declare host', { agentId: msg.agentId, error: toErrorMessage(err) });
      this.access.record(
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
      // No authority: the store's Platform default removes only unconfirmed hosts.
      const deleted = await this.deps.rosterStore.removeStatic(msg.agentId);
      this.access.record(
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
      if (err instanceof HostWriteRefusedError) {
        this.refuse(msg, 'fleet.host.remove', 'dashboard.fleet.host.remove.response', err);
        return;
      }
      logger.error('Failed to remove host', { agentId: msg.agentId, error: toErrorMessage(err) });
      this.access.record(
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
