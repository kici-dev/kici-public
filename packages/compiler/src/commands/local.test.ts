import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../local-plane/plane-manager.js', () => ({
  planeUp: vi.fn().mockResolvedValue({
    running: true,
    pid: 9001,
    port: 4319,
    pgKind: 'embedded',
    url: 'http://127.0.0.1:4319',
  }),
  planeStatus: vi.fn().mockResolvedValue({
    running: true,
    state: 'ready',
    port: 4319,
    pid: 9001,
    pgKind: 'embedded',
    url: 'http://127.0.0.1:4319',
  }),
  planeDown: vi.fn().mockResolvedValue({ stopped: true, port: 4319 }),
  planeLogPath: vi.fn().mockReturnValue('/tmp/x/orchestrator.log'),
  attachPlane: vi.fn().mockResolvedValue({
    running: true,
    port: 4319,
    url: 'http://127.0.0.1:4319',
    mode: 'hybrid',
    attachment: { orgId: 'kiciStg00001' },
  }),
  detachPlane: vi.fn().mockResolvedValue({ running: true, mode: 'independent' }),
}));

vi.mock('../local-plane/resolve-plane.js', () => ({
  resolvePlaneForRun: vi.fn(),
}));

const loadGlobalConfig = vi.fn();
vi.mock('../remote/config.js', () => ({ loadGlobalConfig }));

describe('kici local commands', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // vi.spyOn returns the SAME spy when console.log is already spied, so the
    // recorded calls carry over between tests unless they are cleared here.
    // Without this, a `not.toContain` assertion reads earlier tests' output.
    spy.mockClear();
    errSpy.mockClear();
    loadGlobalConfig.mockReset();
  });

  it('localStatusCommand prints control info and returns true', async () => {
    const { localStatusCommand } = await import('./local.js');
    const ok = await localStatusCommand();
    expect(ok).toBe(true);
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('4319');
    expect(printed).toContain('kici local down');
  });

  it('localStatusCommand --json emits a single machine-readable line', async () => {
    const { localStatusCommand } = await import('./local.js');
    const ok = await localStatusCommand({ json: true });
    expect(ok).toBe(true);
    expect(spy.mock.calls).toHaveLength(1);
    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed).toEqual({
      state: 'ready',
      running: true,
      pid: 9001,
      port: 4319,
      url: 'http://127.0.0.1:4319',
      pgKind: 'embedded',
      stampVersion: null,
      // The shared mock in this file defines no `mode`, so the projection's
      // `?? null` fallback is what is asserted here.
      mode: null,
    });
  });

  it('localStatusCommand --json never emits the plane admin token', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: true,
      state: 'ready',
      pid: 9001,
      port: 4319,
      url: 'http://127.0.0.1:4319',
      pgKind: 'embedded',
      adminToken: 'SUPER-SECRET-ADMIN-TOKEN',
      mode: 'independent',
      attachment: {
        platformWsUrl: 'wss://example/ws',
        platformApiBase: 'https://example',
        orgId: 'org1',
        keyId: 'key1',
      },
    } as never);

    const { localStatusCommand } = await import('./local.js');
    await localStatusCommand({ json: true });
    const printed = String(spy.mock.calls[0][0]);
    expect(printed).not.toContain('SUPER-SECRET-ADMIN-TOKEN');
    expect(printed).not.toContain('adminToken');
    expect(printed).not.toContain('keyId');
  });

  it('localStatusCommand --json returns true for a stopped plane', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: false,
      state: 'stopped',
      mode: 'independent',
    } as never);

    const { localStatusCommand } = await import('./local.js');
    expect(await localStatusCommand({ json: true })).toBe(true);
    // The documented contract: every key is present, and everything the plane
    // cannot supply is an explicit null rather than a missing key — which is
    // what lets a consumer read `.pid // empty` instead of probing for absence.
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toEqual({
      state: 'stopped',
      running: false,
      mode: 'independent',
      pid: null,
      port: null,
      url: null,
      pgKind: null,
      stampVersion: null,
    });
  });

  it('localStatusCommand --json nulls stampVersion for a non-ready plane', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    // planeStatus() populates stampVersion only on its `ours-ready` branch, so
    // the documented "stampVersion is populated only for ready" holds for
    // unready and both foreign states.
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: false,
      state: 'foreign-kici',
      pid: 9001,
      port: 4319,
      pgKind: 'embedded',
      url: 'http://127.0.0.1:4319',
      mode: 'independent',
    } as never);

    const { localStatusCommand } = await import('./local.js');
    await localStatusCommand({ json: true });
    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed.state).toBe('foreign-kici');
    expect(parsed.stampVersion).toBeNull();
    expect(parsed.port).toBe(4319);
  });

  it('localUpCommand boots the plane through the shared resolver and returns true', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({
      kind: 'offline',
      plane: {
        running: true,
        url: 'http://127.0.0.1:4319',
        pgKind: 'embedded',
        mode: 'independent',
      },
    });
    const ok = await localUpCommand();
    expect(ok).toBe(true);
    expect(resolvePlaneForRun).toHaveBeenCalledWith({ offline: false, connected: false });
  });

  it('localDownCommand stops the plane and returns true', async () => {
    const { localDownCommand } = await import('./local.js');
    const { planeDown } = await import('../local-plane/plane-manager.js');
    const ok = await localDownCommand();
    expect(ok).toBe(true);
    expect(planeDown).toHaveBeenCalled();
  });

  it('localStatusCommand reports a stopped plane', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    (planeStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      running: false,
      state: 'stopped',
    });
    const { localStatusCommand } = await import('./local.js');
    const ok = await localStatusCommand();
    expect(ok).toBe(true);
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed.toLowerCase()).toContain('not running');
  });

  it('localDownCommand prints the checkmark and succeeds when the port is freed', async () => {
    const { planeDown } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeDown).mockResolvedValue({ stopped: true, port: 4319 });
    const { localDownCommand } = await import('./local.js');
    expect(await localDownCommand()).toBe(true);
    expect(spy.mock.calls.flat().join(' ')).toContain('Local dev plane stopped.');
  });

  it('localDownCommand fails loudly, naming the holder, when the port stays held', async () => {
    const { planeDown } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeDown).mockResolvedValue({
      stopped: false,
      port: 4319,
      holderPid: 4168194,
      reason: 'port 4319 is still held after stopping pid 4168194',
    });
    const { localDownCommand } = await import('./local.js');
    expect(await localDownCommand()).toBe(false);
    const text = errSpy.mock.calls.flat().join(' ');
    expect(text).toContain('NOT stopped');
    expect(text).toContain('4168194');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('Local dev plane stopped.');
    vi.mocked(planeDown).mockResolvedValue({ stopped: true, port: 4319 });
  });

  it('localStatusCommand surfaces the failing readiness checks of a live plane', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: false,
      state: 'unready',
      port: 4319,
      pid: 4168194,
      url: 'http://127.0.0.1:4319',
      checks: { database: false, warm: true },
      mode: 'independent',
    });
    const { localStatusCommand } = await import('./local.js');
    expect(await localStatusCommand()).toBe(true);
    const text = spy.mock.calls.flat().join(' ');
    expect(text).toContain('running but NOT ready');
    expect(text).toContain('4168194');
    expect(text).toContain('database=false');
    expect(text).not.toContain('Local dev plane is not running.');
  });

  it('localStatusCommand does not claim a foreign KiCI plane is unready', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: false,
      state: 'foreign-kici',
      port: 4319,
      pid: 4168194,
      url: 'http://127.0.0.1:4319',
      mode: 'independent',
    });
    const { localStatusCommand } = await import('./local.js');
    expect(await localStatusCommand()).toBe(true);
    const text = spy.mock.calls.flat().join(' ');
    expect(text).toContain('4168194');
    expect(text).toContain('no stamp in this config dir');
    // `kici local down` DOES reclaim a KiCI holder, so status points at it.
    expect(text).toContain('kici local down');
    // Readiness is never probed for a plane this config dir did not stamp, so
    // status must not report it as measured-unready.
    expect(text).not.toContain('NOT ready');
    expect(text).not.toContain('Local dev plane is not running.');
  });

  it('localStatusCommand names an unrecognised port holder', async () => {
    const { planeStatus } = await import('../local-plane/plane-manager.js');
    vi.mocked(planeStatus).mockResolvedValueOnce({
      running: false,
      state: 'foreign-unknown',
      port: 4319,
      pid: 5555,
      url: 'http://127.0.0.1:4319',
      mode: 'independent',
    });
    const { localStatusCommand } = await import('./local.js');
    await localStatusCommand();
    const text = spy.mock.calls.flat().join(' ');
    expect(text).toContain('not a KiCI plane orchestrator');
    expect(text).toContain('5555');
    // `kici local down` deliberately refuses to signal a foreign holder, so
    // status must not send the operator to it, and must not call the holder a
    // running local dev plane.
    expect(text).not.toContain('kici local down');
    expect(text).not.toContain('Local dev plane is running');
  });

  it('localAttachCommand attaches when logged in with an active org', async () => {
    loadGlobalConfig.mockResolvedValue({
      pat: 'kici_pat_abc',
      platformEndpoint: 'https://thinker1.dev.kici.dev/kici-stg',
      activeOrgId: 'kiciStg00001',
    });
    const { localAttachCommand } = await import('./local.js');
    const { attachPlane } = await import('../local-plane/plane-manager.js');
    const ok = await localAttachCommand();
    expect(ok).toBe(true);
    expect(attachPlane).toHaveBeenCalledWith({
      apiBase: 'https://thinker1.dev.kici.dev/kici-stg',
      pat: 'kici_pat_abc',
      orgId: 'kiciStg00001',
    });
  });

  it('localAttachCommand errors without a PAT', async () => {
    loadGlobalConfig.mockResolvedValue({});
    const { localAttachCommand } = await import('./local.js');
    const { attachPlane } = await import('../local-plane/plane-manager.js');
    (attachPlane as ReturnType<typeof vi.fn>).mockClear();
    const ok = await localAttachCommand();
    expect(ok).toBe(false);
    expect(attachPlane).not.toHaveBeenCalled();
    const printed = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('kici login');
  });

  it('localAttachCommand errors without an active org', async () => {
    loadGlobalConfig.mockResolvedValue({
      pat: 'kici_pat_abc',
      platformEndpoint: 'https://x',
    });
    const { localAttachCommand } = await import('./local.js');
    const ok = await localAttachCommand();
    expect(ok).toBe(false);
    const printed = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('kici org use');
  });

  it('localDetachCommand detaches the plane', async () => {
    loadGlobalConfig.mockResolvedValue({ pat: 'kici_pat_abc' });
    const { localDetachCommand } = await import('./local.js');
    const { detachPlane } = await import('../local-plane/plane-manager.js');
    const ok = await localDetachCommand();
    expect(ok).toBe(true);
    expect(detachPlane).toHaveBeenCalledWith({ pat: 'kici_pat_abc' });
  });
});

describe('localUpCommand honors attachment', () => {
  const plane = {
    running: true as const,
    url: 'http://localhost:10142',
    port: 10142,
    pgKind: 'embedded' as const,
    mode: 'hybrid' as const,
  };
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    spy.mockClear();
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockReset();
  });

  it('boots hybrid when the plane is attached + reachable', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({ kind: 'attached', plane, orgId: 'org-x' });
    const ok = await localUpCommand({});
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(resolvePlaneForRun).toHaveBeenCalledWith({ offline: false, connected: false });
    expect(ok).toBe(true);
    expect(printed).toMatch(/hybrid.*org-x/i);
  });

  it('surfaces the fallback reason when attached but the Platform is unreachable', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({
      kind: 'fallback',
      plane: { ...plane, mode: 'independent' },
      reason: 'Platform unreachable',
    });
    const ok = await localUpCommand({});
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(ok).toBe(true);
    expect(printed).toMatch(/independent|offline/i);
    expect(printed).toMatch(/Platform unreachable/);
  });

  it('renders the offline line for a never-attached plane', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({
      kind: 'offline',
      plane: { ...plane, mode: 'independent' },
    });
    const ok = await localUpCommand({});
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(ok).toBe(true);
    expect(printed).toMatch(/independent\/offline/i);
    expect(printed).not.toMatch(/⚠/);
  });

  it('forces independent with --offline', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({
      kind: 'offline',
      plane: { ...plane, mode: 'independent' },
    });
    await localUpCommand({ offline: true });
    expect(resolvePlaneForRun).toHaveBeenCalledWith({ offline: true, connected: false });
  });

  it('forwards --connected to the resolver', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({ kind: 'attached', plane, orgId: 'org-x' });
    await localUpCommand({ connected: true });
    expect(resolvePlaneForRun).toHaveBeenCalledWith({ offline: false, connected: true });
  });

  it('returns false and prints the error on a resolver error', async () => {
    const { localUpCommand } = await import('./local.js');
    const { resolvePlaneForRun } = await import('../local-plane/resolve-plane.js');
    vi.mocked(resolvePlaneForRun).mockResolvedValue({ error: 'boom' });
    const ok = await localUpCommand({});
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(ok).toBe(false);
    expect(printed).toMatch(/boom/);
  });
});
