import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workflow } from '@kici-dev/sdk';
import type { SimulatedEvent } from '@kici-dev/engine';
import {
  acquireWorkflowLock,
  resolveConcurrencyKey,
  ConcurrencyKeyEvaluationError,
  __setKillFnForTesting,
  type LockHolderMetadata,
} from './workflow-lock.js';

/** Build a minimal Workflow with optional concurrency block for tests. */
function makeWorkflow(name: string, concurrency?: Workflow['concurrency']): Workflow {
  return {
    _tag: 'Workflow' as const,
    name,
    on: {},
    jobs: [],
    concurrency,
  } as unknown as Workflow;
}

/** Build a minimal push-style simulated event for tests. */
function makeEvent(overrides: Partial<SimulatedEvent> = {}): SimulatedEvent {
  return {
    type: 'push',
    targetBranch: 'main',
    payload: { ref: 'refs/heads/main' },
    ...overrides,
  };
}

describe('workflow-lock', () => {
  let tmpRuntimeDir: string;
  let originalXdg: string | undefined;

  beforeEach(async () => {
    // Per-test isolation: redirect $XDG_RUNTIME_DIR to a fresh temp dir so
    // tests don't pollute each other or the user's real runtime dir.
    tmpRuntimeDir = await mkdtemp(path.join(os.tmpdir(), 'kici-lock-test-'));
    originalXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = tmpRuntimeDir;
  });

  afterEach(async () => {
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
    __setKillFnForTesting(undefined);
    delete process.env.KICI_LOCAL_LOCK_KILL_GRACE_MS;
    await rm(tmpRuntimeDir, { recursive: true, force: true });
  });

  describe('resolveConcurrencyKey', () => {
    it('returns null when workflow has no concurrency block', async () => {
      const wf = makeWorkflow('plain');
      const result = await resolveConcurrencyKey(wf, makeEvent(), 'main');
      expect(result).toBeNull();
    });

    it('returns the group key when group() returns a string', async () => {
      const wf = makeWorkflow('deploy', {
        group: ({ branch }) => `deploy-${branch}`,
      });
      const result = await resolveConcurrencyKey(wf, makeEvent(), 'staging');
      expect(result).toBe('deploy-staging');
    });

    it('passes the normalized event envelope to group() (raw fields under payload)', async () => {
      let seen: unknown;
      const wf = makeWorkflow('envelope', {
        group: ({ event }) => {
          seen = event;
          return `g-${event.type}`;
        },
      });
      const event = makeEvent({
        type: 'pull_request',
        action: 'opened',
        sourceBranch: 'feature',
        payload: { number: 7, pull_request: { number: 7 } },
      });
      const result = await resolveConcurrencyKey(wf, event, 'main');
      expect(result).toBe('g-pull_request');
      const envelope = seen as Record<string, unknown>;
      // Normalized fields at the top level.
      expect(envelope.type).toBe('pull_request');
      expect(envelope.action).toBe('opened');
      expect(envelope.sourceBranch).toBe('feature');
      // Raw provider fields nested under payload, NOT spread at the top level.
      expect((envelope.payload as Record<string, unknown>).number).toBe(7);
      expect(envelope.number).toBeUndefined();
    });

    it('throws ConcurrencyKeyEvaluationError when group() throws', async () => {
      const wf = makeWorkflow('crashy', {
        group: () => {
          throw new Error('boom');
        },
      });
      await expect(resolveConcurrencyKey(wf, makeEvent(), 'main')).rejects.toThrow(
        ConcurrencyKeyEvaluationError,
      );
    });

    it('attaches the workflow name to the error', async () => {
      const wf = makeWorkflow('crashy', {
        group: () => {
          throw new Error('inner');
        },
      });
      try {
        await resolveConcurrencyKey(wf, makeEvent(), 'main');
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConcurrencyKeyEvaluationError);
        const e = err as ConcurrencyKeyEvaluationError;
        expect(e.workflowName).toBe('crashy');
        expect(e.cause?.message).toBe('inner');
      }
    });
  });

  describe('acquireWorkflowLock', () => {
    it('returns null fast when the workflow has no concurrency block', async () => {
      const wf = makeWorkflow('plain');
      const handle = await acquireWorkflowLock({
        workflowName: 'plain',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });
      expect(handle).toBeNull();
    });

    it('acquires immediately when no holder exists', async () => {
      const wf = makeWorkflow('w', { group: () => 'k1' });
      const handle = await acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });
      expect(handle).not.toBeNull();
      // Sidecar should exist with our PID.
      const lockDir = path.join(tmpRuntimeDir, 'kici-local-locks');
      const sidecars = await readdirSafe(lockDir);
      const sidecar = sidecars.find((f) => f.endsWith('.holder.json'));
      expect(sidecar).toBeDefined();
      const meta = JSON.parse(
        await readFile(path.join(lockDir, sidecar!), 'utf8'),
      ) as LockHolderMetadata;
      expect(meta.pid).toBe(process.pid);
      expect(meta.workflowName).toBe('w');
      expect(meta.groupKey).toBe('k1');
      await handle!.release();
    });

    it('serializes two concurrent acquisitions on the same key', async () => {
      const wf = makeWorkflow('w', { group: () => 'serial' });
      const opts = {
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      };

      const events: Array<{ at: number; tag: string }> = [];
      const start = Date.now();

      const first = await acquireWorkflowLock(opts);
      expect(first).not.toBeNull();
      events.push({ at: Date.now() - start, tag: 'first-acquired' });

      // Schedule the second acquire — it should block until we release `first`.
      const secondPromise = acquireWorkflowLock(opts).then((h) => {
        events.push({ at: Date.now() - start, tag: 'second-acquired' });
        return h;
      });

      // Hold the first lock for ~500ms before releasing.
      await new Promise((r) => setTimeout(r, 500));
      events.push({ at: Date.now() - start, tag: 'first-releasing' });
      await first!.release();

      const second = await secondPromise;
      expect(second).not.toBeNull();
      await second!.release();

      // The second acquisition must happen AFTER the first release.
      const firstReleasingAt = events.find((e) => e.tag === 'first-releasing')!.at;
      const secondAcquiredAt = events.find((e) => e.tag === 'second-acquired')!.at;
      expect(secondAcquiredAt).toBeGreaterThanOrEqual(firstReleasingAt);
      // And it should not have happened anywhere near the first acquisition (= no parallelism).
      expect(secondAcquiredAt).toBeGreaterThan(400);
    }, 10_000);

    it('cancelInProgress sends SIGTERM to the holder and proceeds', async () => {
      const lockDir = path.join(tmpRuntimeDir, 'kici-local-locks');
      await mkdir(lockDir, { recursive: true });

      // Pretend a previous run is holding the lock: write a lock dir + sidecar
      // pointing at a synthetic PID we'll claim is alive via the mock kill fn.
      const HOLDER_PID = 424242;
      const killCalls: Array<{ pid: number; signal?: string | number }> = [];
      let holderAlive = true;
      __setKillFnForTesting((pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 0) {
          if (!holderAlive) {
            const e = new Error('no such process') as NodeJS.ErrnoException;
            e.code = 'ESRCH';
            throw e;
          }
          return true;
        }
        if (signal === 'SIGTERM') {
          // Holder "exits" cleanly on SIGTERM.
          holderAlive = false;
          return true;
        }
        return true;
      });

      // Manually plant the lock dir + sidecar that proper-lockfile would have created.
      const wf = makeWorkflow('w', {
        group: () => 'cancel',
        cancelInProgress: true,
      });

      // Acquire once with a non-cancel workflow to plant the lock dir, then
      // overwrite the sidecar to point at our synthetic holder PID.
      const planter = makeWorkflow('w', { group: () => 'cancel' });
      const planterHandle = await acquireWorkflowLock({
        workflowName: 'w',
        workflow: planter,
        event: makeEvent(),
        branch: 'main',
      });
      expect(planterHandle).not.toBeNull();
      // Find the sidecar and rewrite it.
      const files = await readdirSafe(lockDir);
      const sidecarFile = files.find((f) => f.endsWith('.holder.json'))!;
      const sidecarPath = path.join(lockDir, sidecarFile);
      await writeFile(
        sidecarPath,
        JSON.stringify({
          pid: HOLDER_PID,
          startedAt: new Date().toISOString(),
          workflowName: 'w',
          groupKey: 'cancel',
          hostname: os.hostname(),
        }),
      );
      // We do NOT release planterHandle yet — its proper-lockfile entry still
      // owns the lock dir. We need the second acquire to see ELOCKED first.

      // Use a short grace window to keep the test fast.
      process.env.KICI_LOCAL_LOCK_KILL_GRACE_MS = '500';

      const acquirePromise = acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });

      // Give the acquire loop a moment to hit ELOCKED, then release the planter
      // to simulate the holder having "died" (SIGTERM-induced).
      await new Promise((r) => setTimeout(r, 100));
      await planterHandle!.release();

      const handle = await acquirePromise;
      expect(handle).not.toBeNull();

      // SIGTERM must have been sent to the synthetic holder.
      expect(killCalls.some((c) => c.pid === HOLDER_PID && c.signal === 'SIGTERM')).toBe(true);

      await handle!.release();
    }, 10_000);

    it('reclaims a stale lock whose holder PID is dead', async () => {
      const wf = makeWorkflow('w', { group: () => 'stale' });
      // First acquire — release WITHOUT cleaning sidecar so the next caller
      // sees a "leaked" lock dir + sidecar pointing at us.
      const first = await acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });
      expect(first).not.toBeNull();

      // Plant a sidecar with a definitely-dead PID so the reclamation path
      // takes the dead-holder branch (host matches; PID is gone).
      const lockDir = path.join(tmpRuntimeDir, 'kici-local-locks');
      const files = await readdirSafe(lockDir);
      const sidecarFile = files.find((f) => f.endsWith('.holder.json'))!;
      const sidecarPath = path.join(lockDir, sidecarFile);
      await writeFile(
        sidecarPath,
        JSON.stringify({
          pid: 99999999,
          startedAt: new Date().toISOString(),
          workflowName: 'w',
          groupKey: 'stale',
          hostname: os.hostname(),
        }),
      );

      // Mock the kill probe: any call with signal=0 for PID 99999999 throws ESRCH.
      __setKillFnForTesting((pid, signal) => {
        if (signal === 0 && pid === 99999999) {
          const e = new Error('no such process') as NodeJS.ErrnoException;
          e.code = 'ESRCH';
          throw e;
        }
        return process.kill(pid, signal);
      });

      // Try to acquire from a "second" caller. The lock dir is still held by
      // proper-lockfile's in-process registry (because we haven't released
      // first yet), so we release it now to make the lock-dir physically free
      // — but the sidecar we wrote stays, simulating a leaked holder file.
      await first!.release();
      // Re-plant the sidecar (release deletes it).
      await writeFile(
        sidecarPath,
        JSON.stringify({
          pid: 99999999,
          startedAt: new Date().toISOString(),
          workflowName: 'w',
          groupKey: 'stale',
          hostname: os.hostname(),
        }),
      );
      // Re-create the lock dir to simulate a leak (proper-lockfile's mkdir-based lock).
      await mkdir(`${path.join(lockDir, sidecarFile.replace('.holder.json', '.lock'))}.lock`, {
        recursive: true,
      });

      const second = await acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });
      expect(second).not.toBeNull();
      await second!.release();
    }, 10_000);

    it('surfaces ConcurrencyKeyEvaluationError when group() throws', async () => {
      const wf = makeWorkflow('w', {
        group: () => {
          throw new Error('group-blew-up');
        },
      });
      await expect(
        acquireWorkflowLock({
          workflowName: 'w',
          workflow: wf,
          event: makeEvent(),
          branch: 'main',
        }),
      ).rejects.toBeInstanceOf(ConcurrencyKeyEvaluationError);
    });

    it('treats a corrupt/missing sidecar as held-by-unknown and waits', async () => {
      const wf = makeWorkflow('w', { group: () => 'corrupt' });
      const first = await acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });
      expect(first).not.toBeNull();

      // Corrupt the sidecar so readSidecar() returns null.
      const lockDir = path.join(tmpRuntimeDir, 'kici-local-locks');
      const files = await readdirSafe(lockDir);
      const sidecarFile = files.find((f) => f.endsWith('.holder.json'))!;
      await writeFile(path.join(lockDir, sidecarFile), '{not valid json');

      // Schedule a second acquire — it should block (wait path), not crash.
      const secondPromise = acquireWorkflowLock({
        workflowName: 'w',
        workflow: wf,
        event: makeEvent(),
        branch: 'main',
      });

      // Race against a timeout: confirm second is still pending after a beat.
      const settled = await Promise.race([
        secondPromise.then(() => 'acquired'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 600)),
      ]);
      expect(settled).toBe('timeout');

      await first!.release();
      const second = await secondPromise;
      expect(second).not.toBeNull();
      await second!.release();
    }, 10_000);
  });
});

/** Best-effort readdir that returns [] if the dir doesn't exist yet. */
async function readdirSafe(dir: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// Avoid "vi imported but unused" when no spies are needed. (vi may be used in
// future additions; reference it explicitly here so the import stays.)
void vi;
