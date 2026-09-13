import { describe, it, expect, vi } from 'vitest';
import type { Step, StepContext } from '@kici-dev/sdk';
import { runParallelGroup } from './parallel-scheduler.js';
import type { StepLoopOptions, StepNode } from './step-loop.js';
import type { RunnerToAgentMessage } from './ipc-protocol.js';

type ParallelNode = Extract<StepNode, { kind: 'parallel' }>;
type ChildFn = (ctx: StepContext) => Promise<unknown>;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkChild(
  name: string,
  fn: ChildFn,
  stepIndex: number,
  opts: { continueOnError?: boolean } = {},
): { step: Step; stepIndex: number } {
  return {
    step: {
      _tag: 'Step',
      name,
      run: fn,
      outputs: undefined,
      ...(opts.continueOnError ? { continueOnError: true } : {}),
    } as unknown as Step,
    stepIndex,
  };
}

function mkGroup(
  groupId: string,
  failFast: boolean,
  maxParallel: number | undefined,
  children: { step: Step; stepIndex: number }[],
): ParallelNode {
  return {
    kind: 'parallel',
    groupId,
    name: groupId,
    failFast,
    ...(maxParallel !== undefined ? { maxParallel } : {}),
    children,
  };
}

/** Build a StepLoopOptions stub with per-step abort controllers + IPC capture. */
function fakeOpts(onStatus?: (m: { stepIndex: number; state: string }) => void): StepLoopOptions {
  const controllers = new Map<number, AbortController>();
  const sendIpc = (msg: RunnerToAgentMessage) => {
    if (msg.type === 'step.start') {
      onStatus?.({ stepIndex: msg.stepIndex, state: msg.state ?? 'running' });
    } else if (msg.type === 'step.complete') {
      onStatus?.({ stepIndex: msg.stepIndex, state: msg.status });
    }
  };
  return {
    steps: [],
    sendIpc,
    defaultTimeoutMs: 60_000,
    outputsMap: new Map(),
    event: {},
    env: {},
    createStepContext: (stepIndex: number) => {
      const c = new AbortController();
      controllers.set(stepIndex, c);
      return { signal: c.signal } as unknown as StepContext;
    },
    abortStep: (stepIndex: number) => controllers.get(stepIndex)?.abort(),
    getStepAbortSignal: (stepIndex: number) => controllers.get(stepIndex)?.signal,
  } as unknown as StepLoopOptions;
}

describe('runParallelGroup', () => {
  it('runs children concurrently (each its own reported step)', async () => {
    const order: string[] = [];
    const node = mkGroup('g0', true, undefined, [
      mkChild(
        'a',
        async () => {
          await tick(25);
          order.push('a');
        },
        1,
      ),
      mkChild(
        'b',
        async () => {
          await tick(5);
          order.push('b');
        },
        2,
      ),
    ]);
    const res = await runParallelGroup(node, fakeOpts());
    expect(res.failed).toBe(false);
    expect(order).toEqual(['b', 'a']); // true concurrency: b finishes first
    expect(res.results.map((r) => r.status)).toEqual(['success', 'success']);
  });

  it('fail-fast aborts in-flight siblings via ctx.signal', async () => {
    const aborted = vi.fn();
    const node = mkGroup('g0', true, undefined, [
      mkChild(
        'boom',
        async () => {
          await tick(2);
          throw new Error('x');
        },
        1,
      ),
      mkChild(
        'slow',
        async (ctx) => {
          ctx.signal.addEventListener('abort', aborted);
          await tick(500);
        },
        2,
      ),
    ]);
    const res = await runParallelGroup(node, fakeOpts());
    expect(res.failed).toBe(true);
    expect(res.failedStepName).toBe('boom');
    expect(aborted).toHaveBeenCalled();
    const slow = res.results.find((r) => r.name === 'slow');
    expect(slow?.status).toBe('cancelled');
  });

  it('maxParallel emits pending for queued children', async () => {
    const states: string[] = [];
    const slow = async () => {
      await tick(10);
    };
    const node = mkGroup('g0', true, 2, [
      mkChild('a', slow, 1),
      mkChild('b', slow, 2),
      mkChild('c', slow, 3),
    ]);
    await runParallelGroup(
      node,
      fakeOpts((m) => states.push(`${m.stepIndex}:${m.state}`)),
    );
    expect(states).toContain('3:pending');
  });

  it('continueOnError child failure does not trip fail-fast', async () => {
    const node = mkGroup('g0', true, undefined, [
      mkChild(
        'soft',
        async () => {
          throw new Error('x');
        },
        1,
        { continueOnError: true },
      ),
      mkChild('ok', async () => {}, 2),
    ]);
    const res = await runParallelGroup(node, fakeOpts());
    expect(res.failed).toBe(false);
  });
});
