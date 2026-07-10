import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('./postgres.js', () => ({
  startPlanePostgres: vi.fn().mockResolvedValue({
    url: 'postgres://kici:kici@127.0.0.1:45432/kici_local',
    kind: 'embedded',
    stop: vi.fn(),
  }),
  stopPlanePostgres: vi.fn().mockResolvedValue(undefined),
  PLANE_PG_CONTAINER: 'kici-local-postgres',
}));
vi.mock('./orchestrator-process.js', () => ({
  spawnOrchestrator: vi.fn().mockResolvedValue({ pid: 9001, port: 4319 }),
  orchestratorReady: vi.fn(),
}));
vi.mock('./scaler-config.js', () => ({
  writeScalerConfig: vi.fn().mockReturnValue('/tmp/scaler.yaml'),
}));
vi.mock('./platform-attach.js', () => ({
  derivePlatformWsUrl: vi.fn().mockReturnValue('wss://thinker1.dev.kici.dev/kici-stg/ws'),
  mintOrchestratorKey: vi
    .fn()
    .mockResolvedValue({ key: 'kici_ok_secret', keyId: 'key-123', keyPrefix: 'kici_ok_' }),
  revokeOrchestratorKey: vi.fn().mockResolvedValue(true),
}));

describe('planeUp / planeStatus / planeDown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KICI_CONFIG_DIR = `/tmp/plane-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it('planeUp boots when nothing is running and writes a stamp', async () => {
    const { orchestratorReady } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { planeUp } = await import('./plane-manager.js');
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(st.pid).toBe(9001);
    expect(st.pgKind).toBe('embedded');
  });

  it('planeUp is idempotent when a healthy plane exists', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { planeUp } = await import('./plane-manager.js');
    await planeUp();
    (spawnOrchestrator as ReturnType<typeof vi.fn>).mockClear();
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(spawnOrchestrator).not.toHaveBeenCalled();
  });

  it('planeUp recreates the plane on an incompatible stamp version', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths, PLANE_STAMP_VERSION } = await import('./paths.js');
    const paths = planePaths();
    // Seed a stamp from an incompatible layout plus a marker file in pgData.
    fs.mkdirSync(paths.pgData, { recursive: true });
    fs.writeFileSync(path.join(paths.pgData, 'marker'), 'stale');
    fs.writeFileSync(
      paths.stampFile,
      JSON.stringify({
        orchestratorPid: 2147480000,
        port: 4319,
        pgKind: 'embedded',
        kiciVersion: '0.0.0',
        stampVersion: 0,
      }),
    );
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(st.stampVersion).toBe(PLANE_STAMP_VERSION);
    // The stale data dir was wiped as part of the recreate.
    expect(fs.existsSync(path.join(paths.pgData, 'marker'))).toBe(false);
    expect(spawnOrchestrator).toHaveBeenCalled();
  });

  it('planeUp generates a dev-signed identity keypair and passes it to the orchestrator', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { planeUp, devIdentityKeyFile } = await import('./plane-manager.js');
    await planeUp();
    const keyFile = devIdentityKeyFile();
    // Private JWK persisted at mode 0600, freshly generated (EC P-256 with `d`).
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const jwk = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    expect(typeof jwk.d).toBe('string');
    // The private-key path is threaded to spawnOrchestrator.
    const call = (spawnOrchestrator as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[1].devIdentityKeyFile).toBe(keyFile);
  });

  it('readOrCreateDevIdentity is stable across calls (does not regenerate)', async () => {
    const { readOrCreateDevIdentity } = await import('./plane-manager.js');
    const first = readOrCreateDevIdentity();
    const contentA = fs.readFileSync(first, 'utf-8');
    const second = readOrCreateDevIdentity();
    const contentB = fs.readFileSync(second, 'utf-8');
    expect(second).toBe(first);
    expect(contentB).toBe(contentA); // same keypair reused
  });

  it('planeUp defaults to independent mode with no attachment', async () => {
    const { orchestratorReady } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { planeUp, readAttachment } = await import('./plane-manager.js');
    const st = await planeUp();
    expect(st.mode).toBe('independent');
    expect(st.attachment).toBeUndefined();
    expect(readAttachment()).toBeNull();
  });

  it('attachPlane mints a key, boots hybrid, and persists the token (0600) + durable attachment', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { attachPlane, readAttachment, readPlatformToken } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    const st = await attachPlane({
      apiBase: 'https://thinker1.dev.kici.dev/kici-stg',
      pat: 'kici_pat_abc',
      orgId: 'kiciStg00001',
    });
    expect(st.mode).toBe('hybrid');
    expect(st.attachment).toMatchObject({
      platformWsUrl: 'wss://thinker1.dev.kici.dev/kici-stg/ws',
      platformApiBase: 'https://thinker1.dev.kici.dev/kici-stg',
      orgId: 'kiciStg00001',
      keyId: 'key-123',
    });
    // Orchestrator booted hybrid with the minted token.
    const call = (spawnOrchestrator as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[1].attach).toMatchObject({
      platformWsUrl: 'wss://thinker1.dev.kici.dev/kici-stg/ws',
      platformToken: 'kici_ok_secret',
    });
    // Token persisted 0600, NOT in the stamp; durable attachment written.
    expect(readPlatformToken()).toBe('kici_ok_secret');
    expect(fs.statSync(planePaths().platformTokenFile).mode & 0o777).toBe(0o600);
    const stamp = JSON.parse(fs.readFileSync(planePaths().stampFile, 'utf-8'));
    expect(stamp.attachment).toBeUndefined(); // never in the stamp
    expect(readAttachment()?.keyId).toBe('key-123');
  });

  it('planeUp({attach}) is idempotent when a healthy hybrid plane exists', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { attachPlane } = await import('./plane-manager.js');
    await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    (spawnOrchestrator as ReturnType<typeof vi.fn>).mockClear();
    const st = await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    expect(st.mode).toBe('hybrid');
    expect(spawnOrchestrator).not.toHaveBeenCalled(); // healthy hybrid reused
  });

  it('planeUp() reboots a running hybrid plane to independent (mode switch)', async () => {
    const { orchestratorReady, spawnOrchestrator } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { attachPlane, planeUp } = await import('./plane-manager.js');
    await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    (spawnOrchestrator as ReturnType<typeof vi.fn>).mockClear();
    const st = await planeUp(); // no attach → wants independent
    expect(st.mode).toBe('independent');
    expect(spawnOrchestrator).toHaveBeenCalled(); // rebooted, not reused
  });

  it('detachPlane clears the token + attachment and reboots independent', async () => {
    const { orchestratorReady } = await import('./orchestrator-process.js');
    (orchestratorReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { attachPlane, detachPlane, readAttachment, readPlatformToken } =
      await import('./plane-manager.js');
    const { revokeOrchestratorKey } = await import('./platform-attach.js');
    await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    const st = await detachPlane({ pat: 'kici_pat_abc' });
    expect(st.mode).toBe('independent');
    expect(readAttachment()).toBeNull();
    expect(readPlatformToken()).toBeNull();
    expect(revokeOrchestratorKey).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key-123', orgId: 'o' }),
    );
  });
});

describe('waitForProcessExit', () => {
  it('resolves immediately for a process that is already gone', async () => {
    const { waitForProcessExit } = await import('./plane-manager.js');
    // A very high pid is guaranteed not to exist → ESRCH → immediate resolve.
    const started = Date.now();
    await waitForProcessExit(2147480000, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('waits until a real process (SIGTERM already sent) has exited', async () => {
    const { spawn } = await import('node:child_process');
    const { waitForProcessExit } = await import('./plane-manager.js');
    // A node child that exits promptly on SIGTERM (the default handler).
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    // Give it a moment to be schedulable, then SIGTERM + wait.
    await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM');
    await waitForProcessExit(child.pid!, 5_000);
    // Once waitForProcessExit resolves, the process must be gone.
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it('escalates to SIGKILL when a process outlives the grace period', async () => {
    const { spawn } = await import('node:child_process');
    const { waitForProcessExit } = await import('./plane-manager.js');
    // A node child that ignores SIGTERM, so only SIGKILL can end it.
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM'); // ignored by the child
    // Short grace so the test is fast; waitForProcessExit must SIGKILL it.
    await waitForProcessExit(child.pid!, 300);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
