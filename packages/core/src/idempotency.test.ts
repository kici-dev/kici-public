import { describe, expect, it, vi } from 'vitest';
import { type ConfirmFn, type IdempotentStep, runIdempotentStep } from './idempotency.js';

interface Drift {
  reason: string;
}

function makeStep(overrides: Partial<IdempotentStep<Drift>> = {}): {
  step: IdempotentStep<Drift>;
  check: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  summarize: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn<() => Promise<Drift | null>>().mockResolvedValue({ reason: 'changed' });
  const apply = vi.fn<(drift: Drift) => Promise<void>>().mockResolvedValue(undefined);
  const summarize = vi.fn<(drift: Drift) => string>().mockImplementation((d) => d.reason);
  const step: IdempotentStep<Drift> = {
    name: 'test-step',
    check,
    summarize,
    apply,
    ...overrides,
  };
  return { step, check, apply, summarize };
}

describe('runIdempotentStep', () => {
  it('skips silently when check returns null', async () => {
    const { step, apply } = makeStep();
    step.check = vi.fn<() => Promise<Drift | null>>().mockResolvedValue(null);
    const result = await runIdempotentStep(step, { log: () => {} });
    expect(result.outcome).toBe('skipped');
    expect(result.drift).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns dry-run when dryRun=true and drift is present', async () => {
    const { step, apply } = makeStep();
    const result = await runIdempotentStep(step, { dryRun: true, log: () => {} });
    expect(result.outcome).toBe('dry-run');
    expect(result.drift).toEqual({ reason: 'changed' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies without prompting when yes=true', async () => {
    const { step, apply } = makeStep();
    const confirm = vi.fn<ConfirmFn>().mockResolvedValue(false);
    const result = await runIdempotentStep(step, { yes: true, confirm, log: () => {} });
    expect(result.outcome).toBe('applied');
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ reason: 'changed' });
  });

  it('applies after positive confirm', async () => {
    const { step, apply } = makeStep();
    const confirm = vi.fn<ConfirmFn>().mockResolvedValue(true);
    const result = await runIdempotentStep(step, { confirm, log: () => {} });
    expect(result.outcome).toBe('applied');
    expect(confirm).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('declines without applying on negative confirm', async () => {
    const { step, apply } = makeStep();
    const confirm = vi.fn<ConfirmFn>().mockResolvedValue(false);
    const result = await runIdempotentStep(step, { confirm, log: () => {} });
    expect(result.outcome).toBe('declined');
    expect(apply).not.toHaveBeenCalled();
  });

  it('throws when drift is detected but no confirm/yes/dryRun is provided', async () => {
    const { step, apply } = makeStep();
    await expect(runIdempotentStep(step, { log: () => {} })).rejects.toThrow(/no confirm callback/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('passes drift through to apply and summarize', async () => {
    const drift: Drift = { reason: 'patroni-restart-needed' };
    const { step, apply, summarize } = makeStep();
    step.check = vi.fn<() => Promise<Drift | null>>().mockResolvedValue(drift);
    const confirm = vi.fn<ConfirmFn>().mockResolvedValue(true);
    await runIdempotentStep(step, { confirm, log: () => {} });
    expect(summarize).toHaveBeenCalledWith(drift);
    expect(apply).toHaveBeenCalledWith(drift);
  });

  it('uses opts.log for status lines instead of console', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const { step } = makeStep();
    step.check = vi.fn<() => Promise<Drift | null>>().mockResolvedValue(null);
    await runIdempotentStep(step, { log });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes('test-step'))).toBe(true);
  });

  it('logs the summarized drift before prompting', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const { step } = makeStep();
    step.summarize = () => 'line one\nline two';
    const confirm = vi.fn<ConfirmFn>().mockResolvedValue(false);
    await runIdempotentStep(step, { confirm, log });
    const summaryLines = lines.filter((l) => l.includes('line one') || l.includes('line two'));
    expect(summaryLines).toHaveLength(2);
  });

  it('calls whenInSync and returns its value when drift is null', async () => {
    const whenInSync = vi
      .fn<() => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'existing-123' });
    const step: IdempotentStep<Drift, { id: string }, void> = {
      name: 'fetch-existing',
      check: vi.fn<() => Promise<Drift | null>>().mockResolvedValue(null),
      summarize: () => 'unused',
      apply: vi.fn<(drift: Drift) => Promise<void>>().mockResolvedValue(undefined),
      whenInSync,
    };
    const result = await runIdempotentStep(step, { log: () => {} });
    expect(result.outcome).toBe('skipped');
    expect(result.drift).toBeNull();
    expect(result.result).toEqual({ id: 'existing-123' });
    expect(whenInSync).toHaveBeenCalledOnce();
  });

  it("returns apply's typed return value in result on the applied branch", async () => {
    const apply = vi
      .fn<(drift: Drift) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'created-456' });
    const step: IdempotentStep<Drift, void, { id: string }> = {
      name: 'create-resource',
      check: vi.fn<() => Promise<Drift | null>>().mockResolvedValue({ reason: 'missing' }),
      summarize: (d) => d.reason,
      apply,
    };
    const result = await runIdempotentStep(step, { yes: true, log: () => {} });
    expect(result.outcome).toBe('applied');
    expect(result.drift).toEqual({ reason: 'missing' });
    expect(result.result).toEqual({ id: 'created-456' });
    expect(apply).toHaveBeenCalledWith({ reason: 'missing' });
  });

  it('does NOT call whenInSync when drift is detected', async () => {
    const whenInSync = vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: 'unused' });
    const step: IdempotentStep<Drift, { id: string }, void> = {
      name: 'has-drift',
      check: vi.fn<() => Promise<Drift | null>>().mockResolvedValue({ reason: 'changed' }),
      summarize: (d) => d.reason,
      apply: vi.fn<(drift: Drift) => Promise<void>>().mockResolvedValue(undefined),
      whenInSync,
    };
    const result = await runIdempotentStep(step, { yes: true, log: () => {} });
    expect(result.outcome).toBe('applied');
    expect(whenInSync).not.toHaveBeenCalled();
  });
});
