/**
 * Scheduler for `parallel()` step groups. Each child runs as its own observable step
 * (logs, status, timing, retry, cache, hooks, all task-scoped) through the sequential
 * loop's `runStepIteration`, behind a `maxParallel` window (queued children report
 * `pending`), joined at a barrier. With `failFast`, the first non-`continueOnError`
 * failure aborts every in-flight sibling, reported `cancelled` (NOT a failure).
 */

import { StepConcurrencyKind } from '@kici-dev/engine';
import { runStepIteration, type StepLoopOptions, type StepNode } from './step-loop.js';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import type { SandboxStepResult } from './types.js';

type ParallelNode = Extract<StepNode, { kind: 'parallel' }>;
type ParallelChild = ParallelNode['children'][number];

export interface ParallelGroupOutcome {
  /** True when at least one non-`continueOnError` child failed. */
  failed: boolean;
  /** Name of the first failing child (drives the job failure reason). */
  failedStepName?: string;
  /** Per-child results, in child array order. */
  results: SandboxStepResult[];
}

/**
 * Stamp the parallel-child role and group id on the child's own `step.start` /
 * `step.complete`; cache/secret pseudo-step messages (other stepIndex) pass untouched.
 */
function stampChildSend(
  sendIpc: (msg: RunnerToAgentMessage) => void,
  childStepIndex: number,
  groupId: string,
): (msg: RunnerToAgentMessage) => void {
  return (msg) => {
    if (
      (msg.type === 'step.start' || msg.type === 'step.complete') &&
      msg.stepIndex === childStepIndex
    ) {
      sendIpc({
        ...msg,
        concurrencyKind: StepConcurrencyKind.enum['parallel-child'],
        groupId,
      });
      return;
    }
    sendIpc(msg);
  };
}

/** Announce a child queued behind the `maxParallel` window as `pending`. */
function emitPending(opts: StepLoopOptions, child: ParallelChild, groupId: string): void {
  opts.sendIpc({
    type: 'step.start',
    stepIndex: child.stepIndex,
    stepName: child.step.name,
    state: 'pending',
    concurrencyKind: StepConcurrencyKind.enum['parallel-child'],
    groupId,
  });
}

/** Mark a child that never launched (fail-fast already tripped) as `cancelled`. */
function emitCancelledSkip(
  opts: StepLoopOptions,
  child: ParallelChild,
  groupId: string,
): SandboxStepResult {
  opts.sendIpc({
    type: 'step.start',
    stepIndex: child.stepIndex,
    stepName: child.step.name,
    concurrencyKind: StepConcurrencyKind.enum['parallel-child'],
    groupId,
  });
  opts.sendIpc({
    type: 'step.complete',
    stepIndex: child.stepIndex,
    status: 'cancelled',
    durationMs: 0,
    concurrencyKind: StepConcurrencyKind.enum['parallel-child'],
    groupId,
  });
  return {
    name: child.step.name,
    stepIndex: child.stepIndex,
    status: 'cancelled',
    durationMs: 0,
  };
}

export async function runParallelGroup(
  node: ParallelNode,
  opts: StepLoopOptions,
): Promise<ParallelGroupOutcome> {
  const { children, failFast, groupId } = node;
  const limit = node.maxParallel && node.maxParallel > 0 ? node.maxParallel : children.length;
  const results: SandboxStepResult[] = new Array(children.length);
  const inFlight = new Set<number>();
  let failed = false;
  let failedStepName: string | undefined;

  // Children beyond the initial window wait for a slot.
  for (let i = limit; i < children.length; i++) {
    emitPending(opts, children[i], groupId);
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= children.length) return;
      const child = children[idx];

      if (failFast && failed) {
        results[idx] = emitCancelledSkip(opts, child, groupId);
        continue;
      }

      const childOpts: StepLoopOptions = {
        ...opts,
        sendIpc: stampChildSend(opts.sendIpc, child.stepIndex, groupId),
      };
      inFlight.add(child.stepIndex);
      try {
        const outcome = await runStepIteration(child.step, child.stepIndex, childOpts);
        results[idx] = outcome.result;
        // `shouldBreak` is the hard-failure signal; a `continueOnError` child failure
        // sets `failedStepName` but never trips fail-fast nor fails the job.
        if (outcome.shouldBreak) {
          if (!failed) {
            failed = true;
            failedStepName = outcome.failedStepName ?? child.step.name;
          }
          if (failFast) {
            for (const sibling of inFlight) {
              if (sibling !== child.stepIndex) opts.abortStep?.(sibling);
            }
          }
        }
      } finally {
        inFlight.delete(child.stepIndex);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, children.length) }, () => worker()));
  return { failed, failedStepName, results };
}
