import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTerminalJobProgress, replayPending } from './worker-outbox-relay.js';
import { PeerOutbox } from './peer-outbox.js';
import type { StatusUpdate } from './in-memory-execution-tracker.js';

const term = (): StatusUpdate =>
  ({
    type: 'job',
    runId: 'r1',
    jobId: 'j1',
    status: 'success',
    timestamp: 1,
  }) as StatusUpdate;

describe('worker-outbox-relay', () => {
  it('builds a JobProgress only for terminal kind=job updates', () => {
    expect(buildTerminalJobProgress(term())?.jobId).toBe('j1');
    expect(buildTerminalJobProgress({ ...term(), status: 'running' } as StatusUpdate)).toBeNull();
    expect(buildTerminalJobProgress({ ...term(), type: 'step' } as StatusUpdate)).toBeNull();
  });

  it('replays every pending record for the url', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    try {
      const ob = new PeerOutbox(dir);
      const url = 'wss://coord-a:10143';
      await ob.enqueue(url, buildTerminalJobProgress(term())!);
      const send = vi.fn(() => true);
      replayPending(ob, send, url);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].jobId).toBe('j1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
