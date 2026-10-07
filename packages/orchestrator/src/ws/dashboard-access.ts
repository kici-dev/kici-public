/**
 * Shared access_log plumbing for the dashboard WS handlers: one recorder that
 * writes a `platform_proxy` row per handled frame, and the `audited()` wrapper
 * for handlers whose body is a single store call answered by one response frame.
 */
import { toErrorMessage } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
} from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import { runDetached, type DetachedFailureLogger } from '../helpers/run-detached.js';

/** The org and routing key an access_log row is attributed to. */
export type AccessScope = { orgId: string | null; routingKey: string | null };
export type AccessTarget = { type: AccessLogTargetType; id: string } | null;

/**
 * Writes access_log rows for one dashboard handler. Best-effort: the write runs
 * detached and a failure is logged through the handler's own logger.
 */
export class DashboardAccessRecorder {
  /**
   * @param scope read at every write, so a handler re-bound to another org or
   *   routing key attributes its later rows to the new pair.
   */
  constructor(
    private readonly accessLog: AccessLogWriter | undefined,
    private readonly scope: () => AccessScope,
    private readonly logger: DetachedFailureLogger,
  ) {}

  /** Record a row attributed to the handler's bound scope. */
  record(
    actor: ActorPrincipal,
    action: AccessLogAction,
    target: AccessTarget,
    requestId: string | null,
    outcome: AccessLogOutcome,
    errorMessage?: string | null,
  ): void {
    this.recordIn(this.scope(), actor, action, target, requestId, outcome, errorMessage);
  }

  /** Record a row attributed to an explicit scope (the org that owns the target). */
  recordIn(
    scope: AccessScope,
    actor: ActorPrincipal,
    action: AccessLogAction,
    target: AccessTarget,
    requestId: string | null,
    outcome: AccessLogOutcome,
    errorMessage?: string | null,
  ): void {
    const accessLog = this.accessLog;
    if (!accessLog) return;
    runDetached(
      this.logger,
      'Access log write',
      () =>
        accessLog.record({
          orgId: scope.orgId,
          routingKey: scope.routingKey,
          actor,
          action,
          target,
          requestId,
          source: 'platform_proxy',
          outcome,
          errorMessage: errorMessage ?? null,
        }),
      { requestId },
    );
  }
}

/** Where an audited request writes its row and its answer. */
export interface AuditedIo {
  recorder: DashboardAccessRecorder;
  send: (msg: Record<string, unknown>) => void;
  sendError: (type: string, requestId: string, err: unknown) => void;
}

/** One request's audit identity: who, what, on which target, answered with which frame. */
export interface AuditedRequest {
  msg: { actor: ActorPrincipal; requestId: string };
  action: AccessLogAction;
  target: AccessTarget;
  responseType: string;
  /** The policy gate. Returns false after answering a denied request itself. */
  enforce?: () => Promise<boolean>;
}

/**
 * Run one dashboard request: the optional policy gate, then `body`. On success
 * it records an `allowed` row and sends `{ type: responseType, requestId,
 * ...payload }`; on a throw it records an `error` row with the message and hands
 * the error to `sendError`. A gate that returns false has already answered the
 * request, so nothing else runs. A gate that throws propagates to the caller.
 */
export async function audited(
  args: AuditedIo & AuditedRequest,
  body: () => Promise<Record<string, unknown> | void>,
): Promise<void> {
  const { recorder, msg, action, target, responseType } = args;
  if (args.enforce && !(await args.enforce())) return;
  try {
    const payload = await body();
    recorder.record(msg.actor, action, target, msg.requestId, 'allowed');
    args.send({ type: responseType, requestId: msg.requestId, ...payload });
  } catch (err) {
    recorder.record(msg.actor, action, target, msg.requestId, 'error', toErrorMessage(err));
    args.sendError(responseType, msg.requestId, err);
  }
}
