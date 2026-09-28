import { describe, expect, it, vi } from 'vitest';
import { runDetached } from './run-detached.js';

/** unhandledRejection fires once the microtask queue drains, so wait a macrotask. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function watchUnhandled() {
  const seen = vi.fn();
  process.on('unhandledRejection', seen);
  return { seen, stop: () => process.off('unhandledRejection', seen) };
}

describe('runDetached', () => {
  // fails-when: the rejection is not caught — it reaches the process hook the
  // orchestrator's shutdown treats as fatal.
  it('logs a rejection with the task and its context, and nothing reaches unhandledRejection', async () => {
    const logger = { error: vi.fn() };
    const unhandled = watchUnhandled();
    try {
      runDetached(
        logger,
        'Agent drain',
        async () => {
          throw new Error('Connection terminated unexpectedly');
        },
        { agentId: 'agent-1' },
      );
      await settle();
      expect(logger.error).toHaveBeenCalledWith('Agent drain failed', {
        agentId: 'agent-1',
        error: 'Connection terminated unexpectedly',
      });
      expect(unhandled.seen).not.toHaveBeenCalled();
    } finally {
      unhandled.stop();
    }
  });

  // fails-when: only rejections are handled — a synchronous throw escapes to the caller.
  it('logs a synchronous throw instead of throwing', () => {
    const logger = { error: vi.fn() };
    expect(() =>
      runDetached(logger, 'Frame handler', () => {
        throw new TypeError('boom');
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('Frame handler failed', { error: 'boom' });
  });

  it('reads the context when the failure is logged', async () => {
    const logger = { error: vi.fn() };
    const context: Record<string, unknown> = {};
    runDetached(
      logger,
      'Frame',
      async () => {
        context.messageType = 'agent.status';
        throw new Error('late');
      },
      context,
    );
    await settle();
    expect(logger.error).toHaveBeenCalledWith('Frame failed', {
      messageType: 'agent.status',
      error: 'late',
    });
  });

  // breaks-if-wrong: work that succeeds, or returns no promise, logs nothing.
  it('logs nothing for work that succeeds', async () => {
    const logger = { error: vi.fn() };
    runDetached(logger, 'Tick', async () => 42);
    runDetached(logger, 'Setter', () => undefined);
    await settle();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
