import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import {
  classifyPlane,
  isKiciOrchestratorHealth,
  planeStateOf,
  classificationPid,
  type PlaneProbes,
} from './plane-liveness.js';

/** A real orchestrator /health body, trimmed to the fields the guard reads. */
const KICI_HEALTH = {
  status: 'ok',
  timestamp: '2026-08-02T15:25:00.000Z',
  uptime: 5880.2,
  version: '0.1.28',
  buildCommit: 'deadbeef',
  sdkVersion: '0.1.28',
  sdkBundleHash: 'abc123',
  sharedVersion: '0.1.28',
  sharedBundleHash: 'def456',
  engineVersion: '0.1.28',
  engineBundleHash: 'ghi789',
};

function probes(over: Partial<PlaneProbes> = {}): Partial<PlaneProbes> {
  return {
    isPortFree: async () => false,
    findPortHolderPid: async () => null,
    fetchHealth: async () => null,
    fetchReady: async () => ({ ok: false, checks: {} }),
    isPidAlive: () => false,
    ...over,
  };
}

describe('isKiciOrchestratorHealth', () => {
  it('accepts a real orchestrator health body', () => {
    expect(isKiciOrchestratorHealth(KICI_HEALTH)).toBe(true);
  });

  it('rejects a bare ok status with no build fingerprints', () => {
    expect(isKiciOrchestratorHealth({ status: 'ok', uptime: 1 })).toBe(false);
  });

  it('rejects arbitrary json, null, and non-objects', () => {
    expect(isKiciOrchestratorHealth({ hello: 'world' })).toBe(false);
    expect(isKiciOrchestratorHealth(null)).toBe(false);
    expect(isKiciOrchestratorHealth('ok')).toBe(false);
  });
});

describe('classifyPlane', () => {
  it('returns free when nothing is listening', async () => {
    const c = await classifyPlane(4319, null, probes({ isPortFree: async () => true }));
    expect(c.kind).toBe('free');
    expect(planeStateOf(c)).toBe('stopped');
  });

  it('returns ours-ready when the holder pid matches the stamp and ready is 200', async () => {
    const c = await classifyPlane(
      4319,
      { orchestratorPid: 4242, port: 4319 },
      probes({
        findPortHolderPid: async () => 4242,
        fetchReady: async () => ({ ok: true, checks: { database: true, warm: true } }),
      }),
    );
    expect(c).toEqual({ kind: 'ours-ready', pid: 4242 });
    expect(planeStateOf(c)).toBe('ready');
  });

  it('returns ours-unready with the failing checks when ready is 503', async () => {
    const c = await classifyPlane(
      4319,
      { orchestratorPid: 4242, port: 4319 },
      probes({
        findPortHolderPid: async () => 4242,
        fetchReady: async () => ({ ok: false, checks: { database: false, warm: true } }),
      }),
    );
    expect(c).toEqual({
      kind: 'ours-unready',
      pid: 4242,
      checks: { database: false, warm: true },
    });
    expect(planeStateOf(c)).toBe('unready');
  });

  it('returns foreign-kici when there is no stamp at all', async () => {
    const c = await classifyPlane(
      4319,
      null,
      probes({ findPortHolderPid: async () => 4168194, fetchHealth: async () => KICI_HEALTH }),
    );
    expect(c.kind).toBe('foreign-kici');
    expect(classificationPid(c)).toBe(4168194);
  });

  it('returns foreign-kici when a stamp exists but names a different pid', async () => {
    const c = await classifyPlane(
      4319,
      { orchestratorPid: 1111, port: 4319 },
      probes({ findPortHolderPid: async () => 2222, fetchHealth: async () => KICI_HEALTH }),
    );
    expect(c.kind).toBe('foreign-kici');
  });

  it('returns foreign-unknown when the listener is not a kici orchestrator', async () => {
    const c = await classifyPlane(
      4319,
      null,
      probes({
        findPortHolderPid: async () => 5555,
        fetchHealth: async () => ({ hello: 'world' }),
      }),
    );
    expect(c).toEqual({ kind: 'foreign-unknown', pid: 5555 });
    expect(planeStateOf(c)).toBe('foreign-unknown');
  });

  it('falls back to a live stamped pid when discovery yields null', async () => {
    const c = await classifyPlane(
      4319,
      { orchestratorPid: 4242, port: 4319 },
      probes({
        findPortHolderPid: async () => null,
        isPidAlive: (pid) => pid === 4242,
        fetchReady: async () => ({ ok: true, checks: {} }),
      }),
    );
    expect(c).toEqual({ kind: 'ours-ready', pid: 4242 });
  });

  it('treats a dead stamped pid as foreign when discovery yields null', async () => {
    const c = await classifyPlane(
      4319,
      { orchestratorPid: 4242, port: 4319 },
      probes({
        findPortHolderPid: async () => null,
        isPidAlive: () => false,
        fetchHealth: async () => KICI_HEALTH,
      }),
    );
    expect(c.kind).toBe('foreign-kici');
    expect(classificationPid(c)).toBeNull();
  });
});

describe('classifyPlane default probes', () => {
  it('classifies a holder that accepts but never answers, instead of hanging on it', async () => {
    // The wedged orphan this module exists for: the socket completes the TCP
    // handshake and then goes silent. Without a probe deadline the HTTP client
    // waits out its own multi-minute default and the CLI hangs with it.
    const accepted: net.Socket[] = [];
    const server = net.createServer((s) => {
      accepted.push(s); // Accept the connection and never write a response.
    });
    // Port 0 lets the kernel pick a free one: a hardcoded port is one concurrent
    // listener away from an unhandled EADDRINUSE that reads as an unrelated
    // crash rather than as this test's subject.
    await new Promise<void>((r) => server.listen({ port: 0, host: '127.0.0.1' }, () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const started = Date.now();
      const c = await classifyPlane(port, null);
      expect(c.kind).toBe('foreign-unknown');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      // The probe's aborted socket is still accepted here, and `close` alone
      // waits for it, so drop live connections before closing.
      for (const s of accepted) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe('reclaimPlanePort', () => {
  it('never terminates a foreign-unknown holder', async () => {
    vi.resetModules();
    const terminatePid = vi.fn();
    vi.doMock('./port-holder.js', () => ({
      isPortFree: vi.fn().mockResolvedValue(false),
      findPortHolderPid: vi.fn().mockResolvedValue(5555),
      terminatePid,
      waitForPortFree: vi.fn().mockResolvedValue(false),
    }));
    const { reclaimPlanePort } = await import('./plane-liveness.js');
    const r = await reclaimPlanePort(4319, { kind: 'foreign-unknown', pid: 5555 });
    expect(r.freed).toBe(false);
    expect(r.error).toContain('5555');
    expect(terminatePid).not.toHaveBeenCalled();
    vi.doUnmock('./port-holder.js');
  });

  it('terminates a foreign-kici holder and reports freed when the port releases', async () => {
    vi.resetModules();
    const terminatePid = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./port-holder.js', () => ({
      isPortFree: vi.fn().mockResolvedValue(false),
      findPortHolderPid: vi.fn().mockResolvedValue(4168194),
      terminatePid,
      waitForPortFree: vi.fn().mockResolvedValue(true),
    }));
    const { reclaimPlanePort } = await import('./plane-liveness.js');
    const health = { uptime: 1 };
    const r = await reclaimPlanePort(4319, { kind: 'foreign-kici', pid: 4168194, health });
    expect(r).toEqual({ freed: true, killedPid: 4168194 });
    expect(terminatePid).toHaveBeenCalledWith(4168194);
    vi.doUnmock('./port-holder.js');
  });

  it('reports not-freed when the port is still held after the kill', async () => {
    vi.resetModules();
    vi.doMock('./port-holder.js', () => ({
      isPortFree: vi.fn().mockResolvedValue(false),
      findPortHolderPid: vi.fn().mockResolvedValue(7),
      terminatePid: vi.fn().mockResolvedValue(undefined),
      waitForPortFree: vi.fn().mockResolvedValue(false),
    }));
    const { reclaimPlanePort } = await import('./plane-liveness.js');
    const r = await reclaimPlanePort(4319, { kind: 'ours-unready', pid: 7, checks: {} });
    expect(r.freed).toBe(false);
    expect(r.killedPid).toBe(7);
    vi.doUnmock('./port-holder.js');
  });

  it('reports not-freed when a kici holder pid could not be determined', async () => {
    const { reclaimPlanePort } = await import('./plane-liveness.js');
    const health = { uptime: 1 };
    const r = await reclaimPlanePort(4319, { kind: 'foreign-kici', pid: null, health });
    expect(r.freed).toBe(false);
    expect(r.error).toContain('pid could not be determined');
  });
});
