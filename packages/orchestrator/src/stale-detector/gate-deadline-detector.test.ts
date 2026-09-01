import { describe, it, expect, vi } from 'vitest';
import { ExecutionJobStatus, TimeoutReason } from '@kici-dev/engine';
import { GateDeadlineDetector, type GateDeadlineDetectorDeps } from './gate-deadline-detector.js';

/** Chainable mock mimicking Kysely's select builder for buildOverdueQuery. */
function createSelectChain(executeResult: unknown[]) {
  const chain: Record<string, any> = {};
  for (const m of ['select', 'where']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.execute = vi.fn(async () => executeResult);
  return chain;
}

function makeDeps(
  overdue: unknown[],
  onJobStatus: ReturnType<typeof vi.fn>,
): GateDeadlineDetectorDeps {
  return {
    db: {
      selectFrom: vi.fn(() => createSelectChain(overdue)),
    } as unknown as GateDeadlineDetectorDeps['db'],
    executionTracker: { onJobStatus } as unknown as GateDeadlineDetectorDeps['executionTracker'],
    scanIntervalMs: 60_000,
  };
}

describe('GateDeadlineDetector', () => {
  it('fails an overdue gate via onJobStatus with a job_timeout reason', async () => {
    const onJobStatus = vi.fn(async () => {});
    const deps = makeDeps([{ run_id: 'run-1', job_id: 'gate-1', timeout_ms: 5000 }], onJobStatus);
    const detector = new GateDeadlineDetector(deps);

    await detector.scan();

    expect(onJobStatus).toHaveBeenCalledTimes(1);
    expect(onJobStatus).toHaveBeenCalledWith(
      'run-1',
      'gate-1',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      { error: `${TimeoutReason.enum.job_timeout}: gate exceeded its timeout of 5000ms` },
    );
  });

  it('does nothing when no gate is overdue', async () => {
    const onJobStatus = vi.fn(async () => {});
    const detector = new GateDeadlineDetector(makeDeps([], onJobStatus));

    await detector.scan();

    expect(onJobStatus).not.toHaveBeenCalled();
  });

  it('fails every overdue gate in the batch', async () => {
    const onJobStatus = vi.fn(async () => {});
    const deps = makeDeps(
      [
        { run_id: 'run-1', job_id: 'gate-1', timeout_ms: 1000 },
        { run_id: 'run-2', job_id: 'gate-2', timeout_ms: 2000 },
      ],
      onJobStatus,
    );
    const detector = new GateDeadlineDetector(deps);

    await detector.scan();

    expect(onJobStatus).toHaveBeenCalledTimes(2);
    expect(onJobStatus.mock.calls.map((c) => c[1])).toEqual(['gate-1', 'gate-2']);
  });
});
