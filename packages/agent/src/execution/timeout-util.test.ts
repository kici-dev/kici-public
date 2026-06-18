import { describe, it, expect } from 'vitest';
import { withTimeout } from './timeout-util.js';

describe('withTimeout', () => {
  it('resolves when function completes within timeout', async () => {
    const result = await withTimeout(() => 42, 1000, 'test');
    expect(result).toBe(42);
  });

  it('resolves async functions within timeout', async () => {
    const result = await withTimeout(
      () => new Promise<string>((r) => setTimeout(() => r('done'), 10)),
      1000,
      'async-test',
    );
    expect(result).toBe('done');
  });

  it('rejects when function exceeds timeout', async () => {
    await expect(withTimeout(() => new Promise(() => {}), 50, 'slow-fn')).rejects.toThrow(
      'Timeout after 50ms evaluating slow-fn',
    );
  });

  it('includes label in timeout error message', async () => {
    await expect(withTimeout(() => new Promise(() => {}), 10, 'my-label')).rejects.toThrow(
      'my-label',
    );
  });

  it('propagates function errors', async () => {
    await expect(
      withTimeout(
        () => {
          throw new Error('boom');
        },
        1000,
        'error-fn',
      ),
    ).rejects.toThrow('boom');
  });

  it('propagates async function rejections', async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error('async-boom')), 1000, 'reject-fn'),
    ).rejects.toThrow('async-boom');
  });
});
