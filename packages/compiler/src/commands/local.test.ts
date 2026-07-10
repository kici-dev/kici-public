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
    port: 4319,
    pid: 9001,
    pgKind: 'embedded',
    url: 'http://127.0.0.1:4319',
  }),
  planeDown: vi.fn().mockResolvedValue(undefined),
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
    (planeStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ running: false });
    const { localStatusCommand } = await import('./local.js');
    const ok = await localStatusCommand();
    expect(ok).toBe(true);
    const printed = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed.toLowerCase()).toContain('not running');
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
