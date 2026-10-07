import { describe, expect, it, vi } from 'vitest';
import type { ActorPrincipal } from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import { DashboardAccessRecorder, audited, type AccessScope } from './dashboard-access.js';

const actor: ActorPrincipal = { type: 'user', sub: 'u1' };

function setup(initial: AccessScope = { orgId: 'org-1', routingKey: 'rk-1' }) {
  let scope = initial;
  const record = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };
  const recorder = new DashboardAccessRecorder(
    { record } as unknown as AccessLogWriter,
    () => scope,
    logger,
  );
  const send = vi.fn();
  const sendError = vi.fn();
  return {
    record,
    logger,
    recorder,
    send,
    sendError,
    rebind: (s: AccessScope) => (scope = s),
  };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('DashboardAccessRecorder', () => {
  // fails-when: a row field is renamed, dropped, or the source changes from platform_proxy
  it('writes the full platform_proxy row under the bound scope', async () => {
    const { record, recorder } = setup();
    recorder.record(actor, 'context.list.read', { type: 'context', id: 'org-1' }, 'r0', 'allowed');
    await flush();
    expect(record).toHaveBeenCalledWith({
      orgId: 'org-1',
      routingKey: 'rk-1',
      actor,
      action: 'context.list.read',
      target: { type: 'context', id: 'org-1' },
      requestId: 'r0',
      source: 'platform_proxy',
      outcome: 'allowed',
      errorMessage: null,
    });
  });

  // fails-when: the scope is captured once at construction instead of read per write
  it('reads the scope at write time, so a re-bound handler attributes to the new pair', async () => {
    const { record, recorder, rebind } = setup();
    rebind({ orgId: 'org-2', routingKey: null });
    recorder.record(actor, 'context.list.read', null, 'r1', 'denied', 'operation_disabled:x');
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-2',
        routingKey: null,
        outcome: 'denied',
        errorMessage: 'operation_disabled:x',
      }),
    );
  });

  // fails-when: recordIn ignores its explicit scope and falls back to the bound one
  it('recordIn attributes to the explicit scope', async () => {
    const { record, recorder } = setup();
    recorder.recordIn(
      { orgId: 'org-run', routingKey: 'rk-run' },
      actor,
      'run.detail.read',
      { type: 'run', id: 'run-1' },
      'r2',
      'allowed',
    );
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-run', routingKey: 'rk-run', requestId: 'r2' }),
    );
  });

  // fails-when: a failing writer throws out of record() instead of being logged
  it('logs a failed write through the handler logger and never throws', async () => {
    const { record, recorder, logger } = setup();
    record.mockRejectedValueOnce(new Error('db down'));
    expect(() => recorder.record(actor, 'context.list.read', null, 'r3', 'allowed')).not.toThrow();
    await flush();
    expect(logger.error).toHaveBeenCalledWith('Access log write failed', {
      requestId: 'r3',
      error: 'db down',
    });
  });

  it('writes nothing when no access log is configured', () => {
    const recorder = new DashboardAccessRecorder(
      undefined,
      () => ({ orgId: null, routingKey: null }),
      {
        error: vi.fn(),
      },
    );
    expect(() => recorder.record(actor, 'context.list.read', null, 'r4', 'allowed')).not.toThrow();
  });
});

describe('audited', () => {
  const base = { msg: { actor, requestId: 'r1' } };

  // fails-when: the success path records 'error', or sends no response
  it('records allowed and sends the payload on success', async () => {
    const { record, recorder, send, sendError } = setup();
    await audited(
      {
        ...base,
        recorder,
        send,
        sendError,
        action: 'context_var.delete',
        target: { type: 'context', id: 'c:k' },
        responseType: 'dashboard.contexts.variables.delete.response',
      },
      async () => ({ deleted: true }),
    );
    await flush();
    expect(send).toHaveBeenCalledWith({
      type: 'dashboard.contexts.variables.delete.response',
      requestId: 'r1',
      deleted: true,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      orgId: 'org-1',
      routingKey: 'rk-1',
      actor,
      action: 'context_var.delete',
      target: { type: 'context', id: 'c:k' },
      requestId: 'r1',
      source: 'platform_proxy',
      outcome: 'allowed',
      errorMessage: null,
    });
    expect(sendError).not.toHaveBeenCalled();
  });

  it('sends only type and requestId for a body that returns nothing', async () => {
    const { recorder, send, sendError } = setup();
    await audited(
      { ...base, recorder, send, sendError, action: 'x' as never, target: null, responseType: 't' },
      async () => undefined,
    );
    expect(send).toHaveBeenCalledWith({ type: 't', requestId: 'r1' });
  });

  // fails-when: a throwing body records allowed, or answers with a success frame
  it('records error with the message and calls sendError on throw', async () => {
    const { record, recorder, send, sendError } = setup();
    await audited(
      {
        ...base,
        recorder,
        send,
        sendError,
        action: 'context_var.delete',
        target: null,
        responseType: 't.response',
      },
      async () => {
        throw new Error('db down');
      },
    );
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', errorMessage: 'db down', target: null }),
    );
    expect(sendError).toHaveBeenCalledWith('t.response', 'r1', expect.any(Error));
    expect(send).not.toHaveBeenCalled();
  });

  // fails-when: a policy denial still runs the body or writes a second row
  it('runs nothing when enforce returns false', async () => {
    const { record, recorder, send, sendError } = setup();
    const body = vi.fn();
    await audited(
      {
        ...base,
        recorder,
        send,
        sendError,
        action: 'x' as never,
        target: null,
        responseType: 't',
        enforce: async () => false,
      },
      body,
    );
    await flush();
    expect(body).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: an allowed policy gate must still run the body
  it('runs the body when enforce returns true', async () => {
    const { recorder, send, sendError } = setup();
    await audited(
      {
        ...base,
        recorder,
        send,
        sendError,
        action: 'x' as never,
        target: null,
        responseType: 't',
        enforce: async () => true,
      },
      async () => ({ ok: 1 }),
    );
    expect(send).toHaveBeenCalledWith({ type: 't', requestId: 'r1', ok: 1 });
  });

  // breaks-if-wrong: the global-workflows scope (routingKey null) is preserved
  it('uses the scope provider, including a null routing key', async () => {
    const { record, recorder, send, sendError } = setup({ orgId: null, routingKey: null });
    await audited(
      { ...base, recorder, send, sendError, action: 'x' as never, target: null, responseType: 't' },
      async () => undefined,
    );
    await flush();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, routingKey: null }));
  });
});
