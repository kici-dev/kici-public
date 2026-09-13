import { describe, it, expect, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { RealLoopLagSource } from './loop-lag-source.js';

const nextTurn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

describe('RealLoopLagSource', () => {
  let src: RealLoopLagSource | undefined;
  afterEach(() => src?.stop());

  it('reports a low delay when the loop is idle', async () => {
    src = new RealLoopLagSource(10);
    src.reset();
    // let a few resolution windows pass without blocking
    await new Promise((r) => setTimeout(r, 120));
    await nextTurn();
    expect(src.max()).toBeLessThan(50);
  });

  it('reports a large delay after a synchronous busy-spin blocks the loop', async () => {
    src = new RealLoopLagSource(10);
    src.reset();
    // Arm the monitor: let a few resolution ticks fire so its interval timer is
    // running before we block the loop, so the stall registers as a late tick.
    await new Promise((r) => setTimeout(r, 30));
    await nextTurn();
    const end = performance.now() + 300;
    while (performance.now() < end) {
      /* busy-spin: the single-threaded loop cannot advance for ~300ms */
    }
    await nextTurn(); // let the monitor record the stall
    await new Promise((r) => setTimeout(r, 20));
    await nextTurn();
    expect(src.max()).toBeGreaterThanOrEqual(250);
    expect(src.p99()).toBeGreaterThanOrEqual(250);
  });
});
