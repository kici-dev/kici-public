import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupGracefulShutdown } from './graceful-shutdown.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Flush enough microtask ticks for a fire-and-forget shutdown chain to settle. */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('setupGracefulShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const signalListeners: Record<string, Array<() => void>> = {};

  beforeEach(() => {
    for (const key of Object.keys(signalListeners)) delete signalListeners[key];
    // Capture process.on registrations without actually binding real signal handlers
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      (signalListeners[event] ??= []).push(listener);
      return process;
    }) as typeof process.on);
    // Swallow process.exit so steps can complete under test
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      return undefined;
    }) as typeof process.exit);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs steps sequentially on SIGTERM and exits 0', async () => {
    const logger = createLogger();
    const order: string[] = [];
    const handle = setupGracefulShutdown({
      logger,
      steps: [
        { name: 'step-1', fn: async () => void order.push('step-1') },
        { name: 'step-2', fn: async () => void order.push('step-2') },
      ],
      skipErrorHandlers: true,
    });

    expect(signalListeners['SIGTERM']).toHaveLength(1);
    expect(signalListeners['SIGINT']).toHaveLength(1);

    await handle.shutdown('SIGTERM');

    expect(order).toEqual(['step-1', 'step-2']);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Received SIGTERM'));
    expect(logger.info).toHaveBeenCalledWith('Graceful shutdown complete', { exitCode: 0 });
  });

  it('continues remaining steps when an earlier step throws', async () => {
    const logger = createLogger();
    const ran: string[] = [];
    const handle = setupGracefulShutdown({
      logger,
      steps: [
        {
          name: 'failing',
          fn: async () => {
            throw new Error('boom');
          },
        },
        { name: 'after-fail', fn: async () => void ran.push('after-fail') },
      ],
      skipErrorHandlers: true,
    });

    await handle.shutdown('SIGTERM');

    expect(ran).toEqual(['after-fail']);
    expect(logger.error).toHaveBeenCalledWith(
      'failing failed',
      expect.objectContaining({ error: expect.stringContaining('boom') }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('ignores subsequent signals while shutdown is in progress', async () => {
    const logger = createLogger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = setupGracefulShutdown({
      logger,
      steps: [{ name: 'slow', fn: () => gate }],
      skipErrorHandlers: true,
    });

    const first = handle.shutdown('SIGTERM');
    const second = handle.shutdown('SIGINT');
    release();
    await Promise.all([first, second]);

    expect(logger.warn).toHaveBeenCalledWith('Shutdown already in progress, ignoring signal', {
      signal: 'SIGINT',
    });
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('force-exits with code 0 when an intentional SIGTERM stop hangs past timeoutMs', async () => {
    const logger = createLogger();
    const hang = new Promise<void>(() => {
      // never resolves
    });
    const handle = setupGracefulShutdown({
      logger,
      steps: [{ name: 'hangs', fn: () => hang }],
      timeoutMs: 5_000,
      skipErrorHandlers: true,
    });

    void handle.shutdown('SIGTERM');
    // Let the async IIFE schedule the setTimeout
    await Promise.resolve();
    vi.advanceTimersByTime(5_000);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('forcing exit'), {
      exitCode: 0,
    });
    // A slow-but-clean SIGTERM stop exits 0 so systemd does not mark the unit
    // `failed` (which would break `systemctl restart` recovery).
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('force-exits with code 1 when a fatal-triggered shutdown hangs past timeoutMs', async () => {
    const logger = createLogger();
    const hang = new Promise<void>(() => {
      // never resolves
    });
    setupGracefulShutdown({
      logger,
      steps: [{ name: 'hangs', fn: () => hang }],
      timeoutMs: 5_000,
    });

    // uncaughtException sets the sticky exitCode to 1 before the step hangs.
    (signalListeners['uncaughtException'][0] as (err: Error) => void)(new Error('boom'));
    await Promise.resolve();
    vi.advanceTimersByTime(5_000);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('forcing exit'), {
      exitCode: 1,
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('skips error handlers when skipErrorHandlers=true', () => {
    const logger = createLogger();
    setupGracefulShutdown({
      logger,
      steps: [],
      skipErrorHandlers: true,
    });
    expect(signalListeners['uncaughtException']).toBeUndefined();
    expect(signalListeners['unhandledRejection']).toBeUndefined();
  });

  it('registers uncaughtException/unhandledRejection by default', () => {
    const logger = createLogger();
    setupGracefulShutdown({ logger, steps: [] });
    expect(signalListeners['uncaughtException']).toHaveLength(1);
    expect(signalListeners['unhandledRejection']).toHaveLength(1);
  });

  it('suppresses default force-exit when onForceExit returns true', async () => {
    const logger = createLogger();
    const onForceExit = vi.fn(() => true);
    const hang = new Promise<void>(() => {});
    const handle = setupGracefulShutdown({
      logger,
      steps: [{ name: 'hangs', fn: () => hang }],
      timeoutMs: 1_000,
      onForceExit,
      skipErrorHandlers: true,
    });

    void handle.shutdown('SIGTERM');
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);

    expect(onForceExit).toHaveBeenCalledTimes(1);
    // default process.exit(1) should NOT fire when onForceExit returns true
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when shutdown is triggered by uncaughtException', async () => {
    const logger = createLogger();
    const ran: string[] = [];
    setupGracefulShutdown({
      logger,
      steps: [{ name: 'teardown', fn: async () => void ran.push('teardown') }],
    });

    expect(signalListeners['uncaughtException']).toHaveLength(1);
    (signalListeners['uncaughtException'][0] as (err: Error) => void)(new Error('boom'));
    await flushMicrotasks();

    expect(ran).toEqual(['teardown']);
    expect(logger.error).toHaveBeenCalledWith(
      'Uncaught exception',
      expect.objectContaining({ error: 'boom' }),
    );
    expect(logger.info).toHaveBeenCalledWith('Graceful shutdown complete', { exitCode: 1 });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when shutdown is triggered by unhandledRejection', async () => {
    const logger = createLogger();
    setupGracefulShutdown({ logger, steps: [] });

    expect(signalListeners['unhandledRejection']).toHaveLength(1);
    (signalListeners['unhandledRejection'][0] as (reason: unknown) => void)(new Error('rejected'));
    await flushMicrotasks();

    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled rejection',
      expect.objectContaining({ reason: 'rejected' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('escalates the exit code when a fatal trigger arrives during a signal shutdown', async () => {
    const logger = createLogger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = setupGracefulShutdown({
      logger,
      steps: [{ name: 'slow', fn: () => gate }],
    });

    const first = handle.shutdown('SIGTERM'); // clean trigger — would exit 0
    (signalListeners['uncaughtException'][0] as (err: Error) => void)(new Error('mid-shutdown'));
    release();
    await first;
    await flushMicrotasks();

    // The duplicate trigger is ignored (no second teardown) but escalates the code.
    expect(logger.warn).toHaveBeenCalledWith('Shutdown already in progress, ignoring signal', {
      signal: 'uncaughtException',
    });
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
