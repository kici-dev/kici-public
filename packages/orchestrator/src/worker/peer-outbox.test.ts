import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerOutbox } from './peer-outbox.js';
import type { JobProgress } from '@kici-dev/engine';

const COORD = 'wss://coord-a:10143';
function progress(runId: string, jobId: string): JobProgress {
  return {
    type: 'job.progress',
    kind: 'job',
    runId,
    jobId,
    jobName: '',
    stepIndex: 0,
    stepName: '',
    state: 'success',
    timestamp: 1000,
  };
}

describe('PeerOutbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists a record and lists it by coordinator', async () => {
    const ob = new PeerOutbox(dir);
    await ob.enqueue(COORD, progress('r1', 'j1'));
    expect(ob.pendingFor(COORD).map((r) => r.message.jobId)).toEqual(['j1']);
  });

  it('survives a restart (new instance over same dir replays records)', async () => {
    const a = new PeerOutbox(dir);
    await a.enqueue(COORD, progress('r1', 'j1'));
    const b = new PeerOutbox(dir);
    await b.loadFromDisk();
    expect(b.pendingFor(COORD).map((r) => r.message.jobId)).toEqual(['j1']);
  });

  it('enqueueSync persists durably before returning and survives a restart', async () => {
    const a = new PeerOutbox(dir);
    a.enqueueSync(COORD, progress('r1', 'j1'));
    // In-memory immediately after the synchronous call returns.
    expect(a.pendingFor(COORD).map((r) => r.message.jobId)).toEqual(['j1']);
    // On disk: a fresh instance recovers it without the original ever awaiting.
    const b = new PeerOutbox(dir);
    await b.loadFromDisk();
    expect(b.pendingFor(COORD).map((r) => r.message.jobId)).toEqual(['j1']);
  });

  it('enqueueSync records are ack-pruned like async ones', async () => {
    const ob = new PeerOutbox(dir);
    ob.enqueueSync(COORD, progress('r1', 'j1'));
    await ob.ack(COORD, 'r1', 'j1');
    expect(ob.pendingFor(COORD)).toEqual([]);
    const b = new PeerOutbox(dir);
    await b.loadFromDisk();
    expect(b.pendingFor(COORD)).toEqual([]);
  });

  it('ack deletes the record and is idempotent', async () => {
    const ob = new PeerOutbox(dir);
    await ob.enqueue(COORD, progress('r1', 'j1'));
    await ob.ack(COORD, 'r1', 'j1');
    await ob.ack(COORD, 'r1', 'j1'); // no throw
    expect(ob.pendingFor(COORD)).toEqual([]);
  });

  it('skips corrupt files on load with no throw', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'garbage__r__j.json'), '{ not json');
    const ob = new PeerOutbox(dir);
    await ob.loadFromDisk();
    expect(ob.pendingFor(COORD)).toEqual([]);
  });

  it('prunes records older than the TTL', async () => {
    const ob = new PeerOutbox(dir, () => 10_000);
    await ob.enqueue(COORD, progress('r1', 'j1'));
    expect(await ob.prune(1000, 20_000)).toBe(1);
    expect(ob.pendingFor(COORD)).toEqual([]);
  });
});
