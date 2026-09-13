import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineLedger } from './machine-ledger.js';

describe('MachineLedger', () => {
  let dir: string;
  let ledgerA: MachineLedger;
  let ledgerB: MachineLedger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-ledger-test-'));
    ledgerA = new MachineLedger({ explicitDir: dir, instanceId: 'orch-a' });
    ledgerB = new MachineLedger({ explicitDir: dir, instanceId: 'orch-b' });
    ledgerA.registerPool('pool-1', { maxCpu: 4, maxMemoryBytes: 4 * 1024 ** 3 });
    ledgerB.registerPool('pool-1', { maxCpu: 4, maxMemoryBytes: 4 * 1024 ** 3 });
  });

  afterEach(async () => {
    ledgerA.stop();
    ledgerB.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('grants the first reservation', async () => {
    const ok = await ledgerA.tryReserve('pool-1', 'agent-1', 1, 1024 ** 3);
    expect(ok).toBe(true);
    const usage = await ledgerA.getUsage('pool-1');
    expect(usage.cpus).toBe(1);
    expect(usage.memBytes).toBe(1024 ** 3);
  });

  it('refuses a reservation that would exceed the cpu cap', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-1', 3, 0)).toBe(true);
    expect(await ledgerA.tryReserve('pool-1', 'agent-2', 2, 0)).toBe(false);
  });

  it('refuses a reservation that would exceed the mem cap', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-1', 0, 3 * 1024 ** 3)).toBe(true);
    expect(await ledgerA.tryReserve('pool-1', 'agent-2', 0, 2 * 1024 ** 3)).toBe(false);
  });

  it('coordinates reservations across two ledger instances on the same pool', async () => {
    // Two orchestrators competing for one 4-cpu pool. Each takes 3 cpus.
    expect(await ledgerA.tryReserve('pool-1', 'agent-a1', 3, 0)).toBe(true);
    // Second orchestrator's request would push the total to 6 → reject.
    expect(await ledgerB.tryReserve('pool-1', 'agent-b1', 3, 0)).toBe(false);
    // Smaller request fits.
    expect(await ledgerB.tryReserve('pool-1', 'agent-b2', 1, 0)).toBe(true);
  });

  it('release returns capacity', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-1', 4, 0)).toBe(true);
    expect(await ledgerA.tryReserve('pool-1', 'agent-2', 1, 0)).toBe(false);
    await ledgerA.release('pool-1', 'agent-1');
    expect(await ledgerA.tryReserve('pool-1', 'agent-2', 1, 0)).toBe(true);
  });

  it('release is idempotent and only affects own-instance rows', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-1', 1, 0)).toBe(true);
    expect(await ledgerB.tryReserve('pool-1', 'agent-1', 1, 0)).toBe(true);
    // Releasing on B should leave A's row in place.
    await ledgerB.release('pool-1', 'agent-1');
    const usage = await ledgerA.getUsage('pool-1');
    expect(usage.cpus).toBe(1);
  });

  it('rejects pools that were never registered', async () => {
    await expect(ledgerA.tryReserve('unknown-pool', 'a', 1, 0)).rejects.toThrow(/not registered/);
  });

  it('rejects mismatched cap between caller and on-disk file', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-1', 1, 0)).toBe(true);
    const ledgerC = new MachineLedger({ explicitDir: dir, instanceId: 'orch-c' });
    ledgerC.registerPool('pool-1', { maxCpu: 8, maxMemoryBytes: 8 * 1024 ** 3 });
    await expect(ledgerC.tryReserve('pool-1', 'agent-2', 1, 0)).rejects.toThrow(/cap mismatch/);
  });

  it('serializes concurrent reservations correctly under contention', async () => {
    // 10 concurrent reservations, each requesting 1 cpu, into a 4-cpu pool.
    // Exactly 4 must succeed.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ledgerA.tryReserve('pool-1', `agent-${i}`, 1, 0)),
    );
    expect(attempts.filter((ok) => ok).length).toBe(4);
  });

  it('releaseAllForInstance only clears this instance', async () => {
    expect(await ledgerA.tryReserve('pool-1', 'agent-a1', 1, 0)).toBe(true);
    expect(await ledgerB.tryReserve('pool-1', 'agent-b1', 1, 0)).toBe(true);
    await ledgerA.releaseAllForInstance();
    const usage = await ledgerB.getUsage('pool-1');
    expect(usage.cpus).toBe(1);
  });
});
