import { describe, it, expect, vi, beforeEach } from 'vitest';

const planeUp = vi.fn();
const readAttachment = vi.fn();
const readPlatformToken = vi.fn();
vi.mock('./plane-manager.js', () => ({
  planeUp: (...a: unknown[]) => planeUp(...a),
  readAttachment: () => readAttachment(),
  readPlatformToken: () => readPlatformToken(),
}));

const probePlatformReachable = vi.fn();
vi.mock('./platform-attach.js', () => ({
  probePlatformReachable: (...a: unknown[]) => probePlatformReachable(...a),
}));

const ATTACHMENT = {
  platformWsUrl: 'wss://thinker1.dev.kici.dev/kici-stg/ws',
  platformApiBase: 'https://thinker1.dev.kici.dev/kici-stg',
  orgId: 'kiciStg00001',
  keyId: 'key-1',
};

describe('resolvePlaneForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planeUp.mockResolvedValue({ running: true, url: 'http://127.0.0.1:4319', mode: 'independent' });
    readPlatformToken.mockReturnValue('kici_ok_secret');
  });

  it('--offline forces the offline plane even when attached', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({ offline: true });
    expect(r).toMatchObject({ kind: 'offline' });
    expect(planeUp).toHaveBeenCalledWith(); // no attach opts
  });

  it('--connected while not attached errors', async () => {
    readAttachment.mockReturnValue(null);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({ connected: true });
    expect('error' in r && r.error).toMatch(/kici local attach/);
  });

  it('--connected attached + reachable boots hybrid', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    probePlatformReachable.mockResolvedValue(true);
    planeUp.mockResolvedValue({ running: true, url: 'http://127.0.0.1:4319', mode: 'hybrid' });
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({ connected: true });
    expect(r).toMatchObject({ kind: 'attached', orgId: 'kiciStg00001' });
    expect(planeUp).toHaveBeenCalledWith({
      attach: expect.objectContaining({ platformToken: 'kici_ok_secret', orgId: 'kiciStg00001' }),
    });
  });

  it('--connected attached + unreachable hard-errors', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    probePlatformReachable.mockResolvedValue(false);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({ connected: true });
    expect('error' in r && r.error).toMatch(/unreachable/);
  });

  it('auto: attached + reachable → attached', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    probePlatformReachable.mockResolvedValue(true);
    planeUp.mockResolvedValue({ running: true, url: 'http://127.0.0.1:4319', mode: 'hybrid' });
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({});
    expect(r).toMatchObject({ kind: 'attached' });
  });

  it('auto: attached + unreachable → loud fallback to offline', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    probePlatformReachable.mockResolvedValue(false);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({});
    expect(r).toMatchObject({ kind: 'fallback', reason: 'Platform unreachable' });
  });

  it('auto: not attached → offline', async () => {
    readAttachment.mockReturnValue(null);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({});
    expect(r).toMatchObject({ kind: 'offline' });
  });

  it('auto: attached + reachable but token missing → fallback (does not fail)', async () => {
    readAttachment.mockReturnValue(ATTACHMENT);
    probePlatformReachable.mockResolvedValue(true);
    readPlatformToken.mockReturnValue(null);
    const { resolvePlaneForRun } = await import('./resolve-plane.js');
    const r = await resolvePlaneForRun({});
    expect(r).toMatchObject({ kind: 'fallback' });
  });
});
