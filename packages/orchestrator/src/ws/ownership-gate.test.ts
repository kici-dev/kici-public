import { describe, it, expect, vi } from 'vitest';
import { gateOwnership } from './ownership-gate.js';
import type { OwnershipTracker } from '../agent/ownership-tracker.js';

function makeTracker(
  checkOwnership: boolean,
  validateAsync: boolean,
): {
  tracker: OwnershipTracker;
  check: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn().mockReturnValue(checkOwnership);
  const validate = vi.fn().mockResolvedValue(validateAsync);
  return {
    tracker: { checkOwnership: check, validateAsync: validate } as unknown as OwnershipTracker,
    check,
    validate,
  };
}

describe('gateOwnership', () => {
  it('accepts when no tracker is configured', async () => {
    await expect(gateOwnership(undefined, 'agent-1', 'job-1', 'job.status')).resolves.toBe(
      'accept',
    );
  });

  it('accepts on a synchronous hit without consulting the database', async () => {
    const { tracker, check, validate } = makeTracker(true, false);

    await expect(gateOwnership(tracker, 'agent-1', 'job-1', 'job.status')).resolves.toBe('accept');

    expect(check).toHaveBeenCalledWith('agent-1', 'job-1', 'job.status');
    expect(validate).not.toHaveBeenCalled();
  });

  it('falls through to the async resolution on a synchronous miss', async () => {
    const { tracker, validate } = makeTracker(false, true);

    await expect(gateOwnership(tracker, 'agent-1', 'job-1', 'job.status')).resolves.toBe('accept');

    expect(validate).toHaveBeenCalledWith('agent-1', 'job-1', 'job.status');
  });

  it('rejects when the async resolution refuses', async () => {
    const { tracker, validate } = makeTracker(false, false);

    await expect(gateOwnership(tracker, 'agent-1', 'job-1', 'job.status')).resolves.toBe('reject');

    expect(validate).toHaveBeenCalledOnce();
  });

  it('passes the message type through to both checks', async () => {
    const { tracker, check, validate } = makeTracker(false, false);

    await gateOwnership(tracker, 'agent-9', 'job-9', 'artifacts.upload.complete');

    expect(check).toHaveBeenCalledWith('agent-9', 'job-9', 'artifacts.upload.complete');
    expect(validate).toHaveBeenCalledWith('agent-9', 'job-9', 'artifacts.upload.complete');
  });

  it('never returns a third state — every frame is decided', async () => {
    for (const [sync, async_] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const { tracker } = makeTracker(sync, async_);
      const decision = await gateOwnership(tracker, 'a', 'j', 'job.status');
      expect(['accept', 'reject']).toContain(decision);
    }
  });
});
