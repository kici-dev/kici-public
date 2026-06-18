import { describe, it, expect, vi } from 'vitest';
import { guardedDashboardDispatch } from './dashboard-dispatch-guard.js';

describe('guardedDashboardDispatch', () => {
  it('emits a structured error frame when the handler throws', async () => {
    const sendRaw = vi.fn();
    await guardedDashboardDispatch(
      {
        sendRaw,
        dispatch: async () => {
          throw new Error('boom');
        },
      },
      { type: 'dashboard.event-dlq.count', requestId: 'r1' },
    );
    expect(sendRaw).toHaveBeenCalledWith({
      type: 'dashboard.event-dlq.count.response',
      requestId: 'r1',
      error: 'boom',
    });
  });

  it('emits a structured error frame for an unhandled message type', async () => {
    const sendRaw = vi.fn();
    await guardedDashboardDispatch(
      { sendRaw, dispatch: async () => false },
      { type: 'dashboard.unknown.thing', requestId: 'r2' },
    );
    expect(sendRaw).toHaveBeenCalledWith({
      type: 'dashboard.unknown.thing.response',
      requestId: 'r2',
      error: 'unsupported dashboard message type: dashboard.unknown.thing',
    });
  });

  it('sends nothing extra when a handler owns the type', async () => {
    const sendRaw = vi.fn();
    await guardedDashboardDispatch(
      { sendRaw, dispatch: async () => true },
      { type: 'dashboard.environments.list', requestId: 'r3' },
    );
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error throw', async () => {
    const sendRaw = vi.fn();
    await guardedDashboardDispatch(
      {
        sendRaw,
        dispatch: async () => {
          throw 'plain string failure';
        },
      },
      { type: 'dashboard.environments.get', requestId: 'r4' },
    );
    expect(sendRaw).toHaveBeenCalledWith({
      type: 'dashboard.environments.get.response',
      requestId: 'r4',
      error: 'plain string failure',
    });
  });
});
