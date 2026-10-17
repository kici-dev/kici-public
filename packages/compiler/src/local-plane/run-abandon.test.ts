import { describe, expect, it, vi } from 'vitest';
import { cancelAbandonedRun, cancelOnSignal } from './run-abandon.js';

describe('cancelAbandonedRun', () => {
  it('force-cancels the run in the plane it was triggered on', async () => {
    const cancel = vi.fn(async () => ({ alreadyTerminal: false, cancelledJobs: 1 }));
    // fails-when: an aborted follow leaves the run queued, so the next plane
    // start dispatches it again beside the operator's next run.
    await expect(
      cancelAbandonedRun('http://127.0.0.1:4319', 'tok', 'run-1', { quiet: true, cancel }),
    ).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith('http://127.0.0.1:4319', 'tok', 'run-1', { force: true });
  });

  it('reports a failed cancel instead of throwing over the original error', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    // breaks-if-wrong: a plane that already stopped must not turn the timeout
    // message into an unhandled rejection.
    await expect(
      cancelAbandonedRun('http://p', 'tok', 'run-2', { quiet: true, cancel }),
    ).resolves.toBe(false);
  });
});

describe('cancelOnSignal', () => {
  function fakeProcess() {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const proc = {
      rawListeners: (s: string) => [...(listeners.get(s) ?? [])],
      removeAllListeners: (s: string) => {
        listeners.delete(s);
        return proc;
      },
      on: (s: string, l: (...a: unknown[]) => void) => {
        listeners.set(s, [...(listeners.get(s) ?? []), l]);
        return proc;
      },
      removeListener: (s: string, l: (...a: unknown[]) => void) => {
        listeners.set(
          s,
          (listeners.get(s) ?? []).filter((x) => x !== l),
        );
        return proc;
      },
      exit: vi.fn(),
      emit: (s: string) => (listeners.get(s) ?? []).forEach((l) => l()),
      listeners,
    };
    return proc;
  }

  it('runs the cancel and cleanup before exiting, with earlier listeners set aside', async () => {
    const proc = fakeProcess();
    const earlyExit = vi.fn();
    proc.on('SIGINT', earlyExit);
    const order: string[] = [];
    const remove = cancelOnSignal(async () => {
      order.push('cancel+cleanup');
    }, proc as never);

    proc.emit('SIGINT');
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(130));
    // fails-when: an earlier exit hook (embedded-postgres on a first bootstrap)
    // still runs and exits before the cancel request finishes.
    expect(earlyExit).not.toHaveBeenCalled();
    // A second Ctrl-C does not start a second cancel.
    expect(order).toEqual(['cancel+cleanup']);
    remove();
  });

  it('restores the earlier listeners and drops its own once uninstalled', () => {
    const proc = fakeProcess();
    const earlier = vi.fn();
    proc.on('SIGTERM', earlier);
    const remove = cancelOnSignal(async () => undefined, proc as never);
    expect(proc.listeners.get('SIGTERM')).not.toContain(earlier);
    remove();
    // breaks-if-wrong: a listener another module owns is lost after the run.
    expect(proc.listeners.get('SIGTERM')).toEqual([earlier]);
    expect(proc.listeners.get('SIGINT')).toEqual([]);
  });
});
