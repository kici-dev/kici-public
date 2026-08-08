import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { gcStaleAgentTmpDirs } from './tmp-gc.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const bases: string[] = [];

afterEach(async () => {
  await Promise.all(bases.splice(0).map((b) => rm(b, { recursive: true, force: true })));
});

async function seed(base: string, name: string, ageMs: number): Promise<string> {
  const p = join(base, name);
  await mkdir(p);
  await writeFile(join(p, 'f'), 'x');
  const then = (Date.now() - ageMs) / 1000;
  await utimes(p, then, then);
  return p;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe('gcStaleAgentTmpDirs', () => {
  it('removes stale agent workdirs and pnpm stores, spares everything else', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-gc-test-'));
    bases.push(base);
    const staleWork = await seed(base, 'kici-Ab3xZ9', 2 * DAY_MS);
    const staleStore = await seed(base, 'kici-pnpm-store-XyZ123', 2 * DAY_MS);
    const freshWork = await seed(base, 'kici-Qw9rT2', 0.5 * DAY_MS);
    const cache = await seed(base, 'kici-e2e-cache', 30 * DAY_MS);

    const removed = await gcStaleAgentTmpDirs(base);

    expect(removed.sort()).toEqual([staleStore, staleWork].sort());
    expect(await exists(staleWork)).toBe(false);
    expect(await exists(staleStore)).toBe(false);
    expect(await exists(freshWork)).toBe(true);
    expect(await exists(cache)).toBe(true);
  });

  it('collects any stale labeled allocator dir (kici-<label>-XXXXXX)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-gc-test-'));
    bases.push(base);
    const stale = await seed(base, 'kici-somelabel-ABC123', 2 * DAY_MS);

    const removed = await gcStaleAgentTmpDirs(base);

    expect(removed).toEqual([stale]);
    expect(await exists(stale)).toBe(false);
  });

  it('collects a stale bare workdir (kici-XXXXXX)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-gc-test-'));
    bases.push(base);
    const stale = await seed(base, 'kici-abc123', 2 * DAY_MS);

    const removed = await gcStaleAgentTmpDirs(base);

    expect(removed).toEqual([stale]);
    expect(await exists(stale)).toBe(false);
  });

  it('defaults its scan base to kiciTmpBase() (follows KICI_TMPDIR)', async () => {
    const savedTmpdir = process.env.KICI_TMPDIR;
    const base = await mkdtemp(join(tmpdir(), 'agent-gc-kicitmpdir-'));
    bases.push(base);
    process.env.KICI_TMPDIR = base;
    try {
      const stale = await seed(base, 'kici-abc123', 2 * DAY_MS);
      // No explicit base arg — the default must resolve to KICI_TMPDIR.
      const removed = await gcStaleAgentTmpDirs();
      expect(removed).toEqual([stale]);
      expect(await exists(stale)).toBe(false);
    } finally {
      if (savedTmpdir === undefined) delete process.env.KICI_TMPDIR;
      else process.env.KICI_TMPDIR = savedTmpdir;
    }
  });

  it('spares the deterministic persistent caches even when stale', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-gc-test-'));
    bases.push(base);
    const payloads = await seed(base, 'kici-agent-payloads', 30 * DAY_MS);
    const data = await seed(base, 'kici-data', 30 * DAY_MS);
    const ledger = await seed(base, 'kici-scaler-ledger', 30 * DAY_MS);

    const removed = await gcStaleAgentTmpDirs(base);

    expect(removed).toEqual([]);
    expect(await exists(payloads)).toBe(true);
    expect(await exists(data)).toBe(true);
    expect(await exists(ledger)).toBe(true);
  });
});
