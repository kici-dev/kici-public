// packages/orchestrator/src/cluster/terminal-status-relay.integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerOutbox } from '../worker/peer-outbox.js';
import { buildTerminalJobProgress, replayPending } from '../worker/worker-outbox-relay.js';
import type { StatusUpdate } from '../worker/in-memory-execution-tracker.js';

describe('terminal status survives a peer-WS drop', () => {
  it('persists while down, replays on reconnect, prunes on ack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-int-'));
    try {
      const url = 'wss://coord-a:10143';
      const ob = new PeerOutbox(dir);
      const update = {
        type: 'job',
        runId: 'r1',
        jobId: 'j1',
        status: 'success',
        timestamp: 1,
      } as StatusUpdate;

      // 1. Worker produces a terminal status; socket is DOWN.
      const msg = buildTerminalJobProgress(update)!;
      await ob.enqueue(url, msg);
      let socketUp = false;
      const send = vi.fn((_m) => socketUp); // false while down
      replayPending(ob, send, url);
      expect(send).toHaveReturnedWith(false);
      expect(ob.pendingFor(url)).toHaveLength(1); // retained

      // 2. Simulate worker restart: brand-new outbox over the same dir.
      const ob2 = new PeerOutbox(dir);
      await ob2.loadFromDisk();
      expect(ob2.pendingFor(url)).toHaveLength(1);

      // 3. Coordinator returns; reconnect replays successfully.
      socketUp = true;
      const delivered: (typeof msg)[] = [];
      replayPending(
        ob2,
        (m) => {
          delivered.push(m);
          return true;
        },
        url,
      );
      expect(delivered.map((m) => m.jobId)).toEqual(['j1']);

      // 4. Coordinator acks → prune.
      await ob2.ack(url, 'r1', 'j1');
      expect(ob2.pendingFor(url)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
