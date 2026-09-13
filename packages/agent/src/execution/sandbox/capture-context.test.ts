import { describe, it, expect } from 'vitest';
import { runInStepCapture, currentCaptureStepIndex } from './capture-context.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('step capture context', () => {
  it('attributes the active index by async context, not a global', async () => {
    const seen: number[] = [];
    await Promise.all([
      runInStepCapture(0, async () => {
        await tick(10);
        seen.push(currentCaptureStepIndex());
      }),
      runInStepCapture(1, async () => {
        await tick(5);
        seen.push(currentCaptureStepIndex());
      }),
    ]);
    // Each closure reports ITS OWN index even though both ran concurrently.
    expect(seen.sort()).toEqual([0, 1]);
  });

  it('returns -1 outside any capture context', () => {
    expect(currentCaptureStepIndex()).toBe(-1);
  });

  it('nested scopes report the innermost index and restore on exit', async () => {
    let inner = -99;
    let afterInner = -99;
    await runInStepCapture(3, async () => {
      await runInStepCapture(7, async () => {
        inner = currentCaptureStepIndex();
      });
      afterInner = currentCaptureStepIndex();
    });
    expect(inner).toBe(7);
    expect(afterInner).toBe(3);
  });
});
