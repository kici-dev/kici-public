import { describe, it, expect, vi } from 'vitest';
import { runBetweenJobsReset } from './between-jobs-reset.js';

describe('runBetweenJobsReset', () => {
  it('skips when no command configured', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0 });
    const r = await runBetweenJobsReset({
      timeoutMs: 1000,
      runOn: 'always',
      jobFailed: false,
      exec,
    });
    expect(r.status).toBe('skipped');
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips on success when runOn=on-failure', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0 });
    const r = await runBetweenJobsReset({
      command: 'x',
      timeoutMs: 1000,
      runOn: 'on-failure',
      jobFailed: false,
      exec,
    });
    expect(r.status).toBe('skipped');
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs on failure when runOn=on-failure', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0 });
    const r = await runBetweenJobsReset({
      command: 'x',
      timeoutMs: 1000,
      runOn: 'on-failure',
      jobFailed: true,
      exec,
    });
    expect(r.status).toBe('success');
    expect(exec).toHaveBeenCalled();
  });

  it('maps a non-zero exit to failed', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 3 });
    const r = await runBetweenJobsReset({
      command: 'x',
      timeoutMs: 1000,
      runOn: 'always',
      jobFailed: false,
      exec,
    });
    expect(r.status).toBe('failed');
  });

  it('maps a timeout to timeout', async () => {
    const exec = vi.fn().mockResolvedValue({ code: null, timedOut: true });
    const r = await runBetweenJobsReset({
      command: 'x',
      timeoutMs: 5,
      runOn: 'always',
      jobFailed: false,
      exec,
    });
    expect(r.status).toBe('timeout');
  });

  it('maps a throwing exec to failed (fail-open)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runBetweenJobsReset({
      command: 'x',
      timeoutMs: 5,
      runOn: 'always',
      jobFailed: false,
      exec,
    });
    expect(r.status).toBe('failed');
  });
});
