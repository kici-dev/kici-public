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
    const runDir = await seed(base, 'kici-run-ab12cd', 30 * DAY_MS); // compiler's family, not ours
    const cache = await seed(base, 'kici-e2e-cache', 30 * DAY_MS);

    const removed = await gcStaleAgentTmpDirs(base);

    expect(removed.sort()).toEqual([staleStore, staleWork].sort());
    expect(await exists(staleWork)).toBe(false);
    expect(await exists(staleStore)).toBe(false);
    expect(await exists(freshWork)).toBe(true);
    expect(await exists(runDir)).toBe(true);
    expect(await exists(cache)).toBe(true);
  });
});
