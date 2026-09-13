import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectRunsOnLabel } from './trusted-routing.js';

describe('injectRunsOnLabel', () => {
  let lockPath: string;

  afterEach(() => {
    if (lockPath) fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  });

  function writeLock(lock: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-trusted-routing-'));
    lockPath = path.join(dir, 'kici.lock.json');
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    return lockPath;
  }

  function read(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  }

  it('appends an exact routing-label selector to every job runsOn', () => {
    writeLock({
      workflows: [
        {
          name: 'wf',
          jobs: [
            { name: 'a', runsOn: [{ kind: 'exact', value: 'default' }] },
            { name: 'b', runsOn: [] },
            { name: 'c' }, // no runsOn at all
          ],
        },
      ],
    });

    injectRunsOnLabel(lockPath, 'self-hosted');
    const patched = read() as { workflows: Array<{ jobs: Array<{ runsOn: unknown[] }> }> };
    const jobs = patched.workflows[0].jobs;
    for (const job of jobs) {
      expect(job.runsOn).toContainEqual({ kind: 'exact', value: 'self-hosted' });
    }
    // The pre-existing selector on job a is preserved.
    expect(jobs[0].runsOn).toContainEqual({ kind: 'exact', value: 'default' });
  });

  it('is idempotent — a second injection does not duplicate the selector', () => {
    writeLock({
      workflows: [{ name: 'wf', jobs: [{ name: 'a', runsOn: [] }] }],
    });
    injectRunsOnLabel(lockPath, 'self-hosted');
    injectRunsOnLabel(lockPath, 'self-hosted');
    const patched = read() as { workflows: Array<{ jobs: Array<{ runsOn: unknown[] }> }> };
    const runsOn = patched.workflows[0].jobs[0].runsOn;
    expect(
      runsOn.filter((m) => JSON.stringify(m) === '{"kind":"exact","value":"self-hosted"}'),
    ).toHaveLength(1);
  });

  it('restore() rewrites the original bytes exactly', () => {
    const lock = { workflows: [{ name: 'wf', jobs: [{ name: 'a', runsOn: [] }] }] };
    writeLock(lock);
    const before = fs.readFileSync(lockPath, 'utf-8');

    const injection = injectRunsOnLabel(lockPath, 'self-hosted');
    expect(fs.readFileSync(lockPath, 'utf-8')).not.toBe(before); // patched

    injection.restore();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(before); // exact original bytes
  });
});
