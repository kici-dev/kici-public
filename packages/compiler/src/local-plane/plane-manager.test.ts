import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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
  spawnOrchestratorProcess: vi.fn().mockReturnValue({ pid: 9001, port: 4319 }),
  awaitOrchestratorReady: vi.fn().mockResolvedValue(undefined),
  orchestratorReady: vi.fn(),
  resolveStandaloneEntry: vi.fn().mockReturnValue('/x/orchestrator/dist/standalone.js'),
  resolveServerEntry: vi.fn().mockReturnValue('/x/orchestrator/dist/server.js'),
}));
vi.mock('./port-holder.js', () => ({
  terminatePid: vi.fn().mockResolvedValue(undefined),
  isPortFree: vi.fn().mockResolvedValue(true),
  findPortHolderPid: vi.fn().mockResolvedValue(null),
  waitForPortFree: vi.fn().mockResolvedValue(true),
  processCommandLine: vi.fn().mockResolvedValue('/usr/bin/node /x/orchestrator/dist/standalone.js'),
}));
vi.mock('./plane-liveness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plane-liveness.js')>();
  return {
    ...actual,
    classifyPlane: vi.fn().mockResolvedValue({ kind: 'free' }),
    reclaimPlanePort: vi.fn().mockResolvedValue({ freed: true }),
  };
});
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

// Static imports of the mocked modules, so the per-case default restoration in
// `beforeEach` does not have to be async. `vi.mock` is hoisted above these.
import { classifyPlane, reclaimPlanePort } from './plane-liveness.js';
import { spawnOrchestratorProcess, awaitOrchestratorReady } from './orchestrator-process.js';
import { isPortFree, processCommandLine } from './port-holder.js';

describe('planeUp / planeStatus / planeDown', () => {
  // Every case boots a plane into its own config dir. They are removed in the
  // afterEach below rather than left in the temp base: each case writes a stamp,
  // a pidfile, an admin token, a secret key and a dev-identity keypair, so a run
  // that leaves them behind accumulates one directory tree per test, per run,
  // forever.
  let configDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears recorded calls but keeps implementations, so a case
    // that narrows one of these leaks its stub into every later case. Restoring
    // the defaults here is what keeps the file order-independent.
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true });
    vi.mocked(spawnOrchestratorProcess).mockReturnValue({ pid: 9001, port: 4319 });
    vi.mocked(awaitOrchestratorReady).mockResolvedValue(undefined);
    vi.mocked(isPortFree).mockResolvedValue(true);
    vi.mocked(processCommandLine).mockResolvedValue(
      '/usr/bin/node /x/orchestrator/dist/standalone.js',
    );
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-plane-test-'));
    process.env.KICI_CONFIG_DIR = configDir;
  });

  // Guaranteed teardown of the injected build-identity globals. The build-stale
  // tests below set these inline and delete them on success; this afterEach
  // ensures a mid-test failure cannot leak a concrete identity into a later
  // test (notably the "current identity is unknown" guard test, which requires
  // no globals to be set).
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).KICI_VERSION;
    delete (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT;
    fs.rmSync(configDir, { recursive: true, force: true });
    delete process.env.KICI_CONFIG_DIR;
  });

  it('planeUp boots when nothing is running and writes a stamp', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    const { planeUp } = await import('./plane-manager.js');
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(st.pid).toBe(9001);
    expect(st.pgKind).toBe('embedded');
  });

  it('planeUp is idempotent when a healthy plane exists', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { planeUp } = await import('./plane-manager.js');
    await planeUp();
    vi.mocked(spawnOrchestratorProcess).mockClear();
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled();
  });

  it('planeUp recreates the plane on an incompatible stamp version', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
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
    expect(spawnOrchestratorProcess).toHaveBeenCalled();
  });

  it('planeUp reboots a running plane on a stale build identity, keeping pgdata', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths, PLANE_STAMP_VERSION } = await import('./paths.js');
    const paths = planePaths();
    // Concrete current identity, different from the seeded stamp below.
    (globalThis as Record<string, unknown>).KICI_VERSION = '0.1.28';
    (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT = 'newcommit';
    fs.mkdirSync(paths.pgData, { recursive: true });
    fs.writeFileSync(path.join(paths.pgData, 'marker'), 'keep-me');
    fs.mkdirSync(path.dirname(paths.stampFile), { recursive: true });
    fs.writeFileSync(
      paths.stampFile,
      JSON.stringify({
        orchestratorPid: 2147480000, // non-existent — SIGTERM throws ESRCH, caught
        port: 4319,
        pgKind: 'embedded',
        kiciVersion: '0.1.26',
        buildCommit: 'oldcommit',
        stampVersion: PLANE_STAMP_VERSION, // current layout: only the identity is stale
      }),
    );
    vi.mocked(spawnOrchestratorProcess).mockClear();
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(spawnOrchestratorProcess).toHaveBeenCalled(); // rebooted, not reused
    // pgdata is PRESERVED on an identity reboot (unlike a stampVersion wipe).
    expect(fs.existsSync(path.join(paths.pgData, 'marker'))).toBe(true);
    delete (globalThis as Record<string, unknown>).KICI_VERSION;
    delete (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT;
  });

  it('planeUp reuses a running plane when the build identity matches', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths, PLANE_STAMP_VERSION } = await import('./paths.js');
    const paths = planePaths();
    (globalThis as Record<string, unknown>).KICI_VERSION = '0.1.28';
    (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT = 'samecommit';
    fs.mkdirSync(path.dirname(paths.stampFile), { recursive: true });
    fs.writeFileSync(
      paths.stampFile,
      JSON.stringify({
        orchestratorPid: 2147480000,
        port: 4319,
        pgKind: 'embedded',
        kiciVersion: '0.1.28',
        buildCommit: 'samecommit',
        stampVersion: PLANE_STAMP_VERSION,
        mode: 'independent',
      }),
    );
    vi.mocked(spawnOrchestratorProcess).mockClear();
    const st = await planeUp();
    expect(st.running).toBe(true);
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled(); // reused
    delete (globalThis as Record<string, unknown>).KICI_VERSION;
    delete (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT;
  });

  it('planeUp does not reboot on a stale stamp when the current identity is unknown', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths, PLANE_STAMP_VERSION } = await import('./paths.js');
    const paths = planePaths();
    // No globals set → current buildCommit resolves to 'unknown' → guard holds.
    fs.mkdirSync(path.dirname(paths.stampFile), { recursive: true });
    fs.writeFileSync(
      paths.stampFile,
      JSON.stringify({
        orchestratorPid: 2147480000,
        port: 4319,
        pgKind: 'embedded',
        kiciVersion: '0.1.26',
        buildCommit: 'oldcommit',
        stampVersion: PLANE_STAMP_VERSION,
        mode: 'independent',
      }),
    );
    vi.mocked(spawnOrchestratorProcess).mockClear();
    await planeUp();
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled(); // reused, not rebooted
  });

  describe('planeBuildIsStale', () => {
    const setIdentity = (version: string, buildCommit: string) => {
      (globalThis as Record<string, unknown>).KICI_VERSION = version;
      (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT = buildCommit;
    };
    const clearIdentity = () => {
      delete (globalThis as Record<string, unknown>).KICI_VERSION;
      delete (globalThis as Record<string, unknown>).KICI_BUILD_COMMIT;
    };
    afterEach(clearIdentity);

    it('is false when there is no existing stamp', async () => {
      setIdentity('9.9.9', 'newcommit');
      const { planeBuildIsStale } = await import('./plane-manager.js');
      expect(planeBuildIsStale(null)).toBe(false);
    });

    it('is true when the stamped version differs', async () => {
      setIdentity('0.1.28', 'samecommit');
      const { planeBuildIsStale } = await import('./plane-manager.js');
      const stamp = {
        orchestratorPid: 1,
        port: 4319,
        pgKind: 'embedded' as const,
        kiciVersion: '0.1.26',
        buildCommit: 'samecommit',
        stampVersion: 3,
      };
      expect(planeBuildIsStale(stamp)).toBe(true);
    });

    it('is true when the stamped build commit differs (same semver)', async () => {
      setIdentity('0.1.28', 'newcommit');
      const { planeBuildIsStale } = await import('./plane-manager.js');
      const stamp = {
        orchestratorPid: 1,
        port: 4319,
        pgKind: 'embedded' as const,
        kiciVersion: '0.1.28',
        buildCommit: 'oldcommit',
        stampVersion: 3,
      };
      expect(planeBuildIsStale(stamp)).toBe(true);
    });

    it('is false when version and commit both match', async () => {
      setIdentity('0.1.28', 'samecommit');
      const { planeBuildIsStale } = await import('./plane-manager.js');
      const stamp = {
        orchestratorPid: 1,
        port: 4319,
        pgKind: 'embedded' as const,
        kiciVersion: '0.1.28',
        buildCommit: 'samecommit',
        stampVersion: 3,
      };
      expect(planeBuildIsStale(stamp)).toBe(false);
    });

    it('is false when the current build identity is unknown (source/test)', async () => {
      clearIdentity(); // no globals → buildCommit resolves to 'unknown'
      const { planeBuildIsStale } = await import('./plane-manager.js');
      const stamp = {
        orchestratorPid: 1,
        port: 4319,
        pgKind: 'embedded' as const,
        kiciVersion: '0.1.26',
        buildCommit: 'oldcommit',
        stampVersion: 3,
      };
      expect(planeBuildIsStale(stamp)).toBe(false);
    });
  });

  it('planeUp generates a dev-signed identity keypair and passes it to the orchestrator', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
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
    // The private-key path is threaded to spawnOrchestratorProcess.
    const call = vi.mocked(spawnOrchestratorProcess).mock.calls.at(-1);
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
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    const { planeUp, readAttachment } = await import('./plane-manager.js');
    const st = await planeUp();
    expect(st.mode).toBe('independent');
    expect(st.attachment).toBeUndefined();
    expect(readAttachment()).toBeNull();
  });

  it('attachPlane mints a key, boots hybrid, and persists the token (0600) + durable attachment', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
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
    const call = vi.mocked(spawnOrchestratorProcess).mock.calls.at(-1);
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
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { attachPlane } = await import('./plane-manager.js');
    await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    vi.mocked(spawnOrchestratorProcess).mockClear();
    const st = await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    expect(st.mode).toBe('hybrid');
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled(); // healthy hybrid reused
  });

  it('planeUp() reboots a running hybrid plane to independent (mode switch)', async () => {
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    const { attachPlane, planeUp } = await import('./plane-manager.js');
    await attachPlane({ apiBase: 'https://x', pat: 'p', orgId: 'o' });
    vi.mocked(spawnOrchestratorProcess).mockClear();
    const st = await planeUp(); // no attach → wants independent
    expect(st.mode).toBe('independent');
    expect(spawnOrchestratorProcess).toHaveBeenCalled(); // rebooted, not reused
  });

  it('detachPlane clears the token + attachment and reboots independent', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
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

  it('planeUp stamps the spawned pid before the readiness wait', async () => {
    const { spawnOrchestratorProcess, awaitOrchestratorReady } =
      await import('./orchestrator-process.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });

    let stampAtWaitTime: string | null = null;
    vi.mocked(awaitOrchestratorReady).mockImplementation(async () => {
      stampAtWaitTime = fs.readFileSync(planePaths().stampFile, 'utf-8');
    });
    vi.mocked(spawnOrchestratorProcess).mockReturnValue({ pid: 9001, port: 4319 });

    await planeUp();
    expect(stampAtWaitTime, 'stamp must exist before the readiness wait').toBeTruthy();
    expect(JSON.parse(stampAtWaitTime!).orchestratorPid).toBe(9001);
    vi.mocked(awaitOrchestratorReady).mockResolvedValue(undefined);
  });

  it('planeUp terminates the child and clears the stamp when readiness times out', async () => {
    const { spawnOrchestratorProcess, awaitOrchestratorReady } =
      await import('./orchestrator-process.js');
    const { terminatePid, isPortFree } = await import('./port-holder.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });

    vi.mocked(spawnOrchestratorProcess).mockReturnValue({ pid: 9002, port: 4319 });
    vi.mocked(awaitOrchestratorReady).mockRejectedValue(new Error('nope'));
    vi.mocked(isPortFree).mockResolvedValue(true);

    await expect(planeUp()).rejects.toThrow('did not become ready');
    expect(terminatePid).toHaveBeenCalledWith(9002);
    expect(fs.existsSync(planePaths().stampFile)).toBe(false);
    vi.mocked(awaitOrchestratorReady).mockResolvedValue(undefined);
  });

  it('planeUp keeps the stamp when the child could not be killed', async () => {
    const { spawnOrchestratorProcess, awaitOrchestratorReady } =
      await import('./orchestrator-process.js');
    const { isPortFree } = await import('./port-holder.js');
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });

    vi.mocked(spawnOrchestratorProcess).mockReturnValue({ pid: 9003, port: 4319 });
    vi.mocked(awaitOrchestratorReady).mockRejectedValue(new Error('nope'));
    vi.mocked(isPortFree).mockResolvedValue(false);

    await expect(planeUp()).rejects.toThrow('did not become ready');
    // The pid is the only way a later `down` can find the survivor.
    expect(JSON.parse(fs.readFileSync(planePaths().stampFile, 'utf-8')).orchestratorPid).toBe(9003);
    vi.mocked(awaitOrchestratorReady).mockResolvedValue(undefined);
    vi.mocked(isPortFree).mockResolvedValue(true);
  });

  it('planeDown reports stopped and clears the stamp once the port is free', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true, killedPid: 9001 });

    const result = await planeDown();
    expect(result).toEqual({ stopped: true, port: 4319, holderPid: 9001 });
    expect(fs.existsSync(planePaths().stampFile)).toBe(false);
  });

  it('planeDown reports NOT stopped and KEEPS the stamp when the port stays held', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    vi.mocked(reclaimPlanePort).mockResolvedValue({
      freed: false,
      killedPid: 9001,
      error: 'port 4319 is still held after stopping pid 9001',
    });

    const result = await planeDown();
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain('still held');
    // The stamp is the only handle on the survivor — it must not be discarded.
    expect(fs.existsSync(planePaths().stampFile)).toBe(true);
  });

  it('planeDown stops a stamped orchestrator that is alive but not holding the port', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { terminatePid } = await import('./port-holder.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    // The port reads free — the stamped orchestrator spawned but has not bound
    // it yet (a boot caught between spawn and bind). The reclaim never signals
    // anything, so without the extra stop the process survives a "successful"
    // teardown and takes the port back moments later.
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true });

    const result = await planeDown();
    expect(terminatePid).toHaveBeenCalledWith(9001);
    expect(result.stopped).toBe(true);
    expect(fs.existsSync(planePaths().stampFile)).toBe(false);
  });

  it('planeDown never signals a stamped pid it cannot identify as our orchestrator', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { terminatePid, processCommandLine } = await import('./port-holder.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    // The stamp outlives its process, so the pid it names may have been
    // recycled onto something unrelated. Signalling it blind would stop a
    // stranger's program — the port is already free, so there is nothing to gain.
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true });
    vi.mocked(processCommandLine).mockResolvedValue('/usr/lib/firefox/firefox');
    vi.mocked(terminatePid).mockClear();

    const result = await planeDown();
    expect(terminatePid).not.toHaveBeenCalled();
    expect(result.stopped).toBe(true);
  });

  it('planeDown treats an unreadable command line as no evidence and does not signal', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { terminatePid, processCommandLine } = await import('./port-holder.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true });
    vi.mocked(processCommandLine).mockResolvedValue(null);
    vi.mocked(terminatePid).mockClear();

    const result = await planeDown();
    expect(terminatePid).not.toHaveBeenCalled();
    expect(result.stopped).toBe(true);
  });

  it('planeDown does not re-signal the stamped pid the reclaim already killed', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { terminatePid } = await import('./port-holder.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true, killedPid: 9001 });

    await planeDown();
    expect(terminatePid).not.toHaveBeenCalled();
  });

  it('planeDown reports NOT stopped when the stamped survivor re-takes the port', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { planeDown, planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true });
    vi.mocked(isPortFree).mockResolvedValue(false);

    const result = await planeDown();
    expect(result.stopped).toBe(false);
    expect(result.holderPid).toBe(9001);
    // The stamp is the only handle on the survivor — it must not be discarded.
    expect(fs.existsSync(planePaths().stampFile)).toBe(true);
  });

  it('planeDown reclaims a foreign kici plane it never stamped', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { stopPlanePostgres } = await import('./postgres.js');
    const { planeDown } = await import('./plane-manager.js');

    const health = { uptime: 1 };
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'foreign-kici', pid: 4168194, health });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true, killedPid: 4168194 });

    const result = await planeDown();
    expect(result).toEqual({ stopped: true, port: 4319, holderPid: 4168194 });
    // With no stamp there is no pgKind, so only the data-dir-scoped embedded
    // backend is stopped. The podman container name is host-global, so removing
    // it could tear down a different plane's database.
    expect(stopPlanePostgres).toHaveBeenCalledWith('embedded');
    expect(stopPlanePostgres).not.toHaveBeenCalledWith('podman');
  });

  it('planeUp reclaims a foreign kici plane and boots fresh instead of adopting it', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { planeUp } = await import('./plane-manager.js');

    const health = { uptime: 5880 };
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'foreign-kici', pid: 4168194, health });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true, killedPid: 4168194 });

    const status = await planeUp();
    expect(reclaimPlanePort).toHaveBeenCalled();
    expect(spawnOrchestratorProcess).toHaveBeenCalled();
    expect(status.running).toBe(true);
  });

  it('planeUp refuses to boot over a listener that is not a kici orchestrator', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { planeUp } = await import('./plane-manager.js');

    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'foreign-unknown', pid: 5555 });
    vi.mocked(reclaimPlanePort).mockResolvedValue({
      freed: false,
      error:
        'port 4319 is held by a process that is not a KiCI plane orchestrator (pid 5555) — refusing to stop it',
    });

    await expect(planeUp()).rejects.toThrow('refusing to stop it');
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled();
  });

  it('planeUp restarts our own stamped-but-unready plane rather than waiting on it', async () => {
    const { classifyPlane, reclaimPlanePort } = await import('./plane-liveness.js');
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp(); // stamp a plane

    vi.mocked(spawnOrchestratorProcess).mockClear();
    vi.mocked(classifyPlane).mockResolvedValue({
      kind: 'ours-unready',
      pid: 9001,
      checks: { database: false, warm: true },
    });
    vi.mocked(reclaimPlanePort).mockResolvedValue({ freed: true, killedPid: 9001 });

    const status = await planeUp();
    expect(spawnOrchestratorProcess).toHaveBeenCalled();
    expect(status.running).toBe(true);
  });

  it('planeUp reuses a healthy plane it stamped', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    const { spawnOrchestratorProcess } = await import('./orchestrator-process.js');
    const { planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(spawnOrchestratorProcess).mockClear();
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });

    const status = await planeUp();
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(9001);
  });

  it('planeStatus reports a live-but-unready plane instead of calling it stopped', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeStatus, planeUp } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });
    await planeUp();

    vi.mocked(classifyPlane).mockResolvedValue({
      kind: 'ours-unready',
      pid: 4168194,
      checks: { database: false, warm: true },
    });

    const status = await planeStatus();
    expect(status.state).toBe('unready');
    expect(status.running).toBe(false);
    expect(status.pid).toBe(4168194);
    expect(status.checks).toEqual({ database: false, warm: true });
    expect(status.url).toBe('http://127.0.0.1:4319');
  });

  it('planeStatus reports a foreign kici holder', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeStatus } = await import('./plane-manager.js');
    const health = { uptime: 1 };
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'foreign-kici', pid: 4168194, health });

    const status = await planeStatus();
    expect(status.state).toBe('foreign-kici');
    expect(status.running).toBe(false);
    expect(status.pid).toBe(4168194);
  });

  it('planeStatus reports stopped when nothing is listening', async () => {
    const { classifyPlane } = await import('./plane-liveness.js');
    const { planeStatus } = await import('./plane-manager.js');
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'free' });

    const status = await planeStatus();
    expect(status.state).toBe('stopped');
    expect(status.running).toBe(false);
  });

  it('planeUp raises the teardown reason instead of booting over a still-held port', async () => {
    const { planeUp } = await import('./plane-manager.js');
    await planeUp(); // stamp a plane so the unready branch has one to tear down

    vi.mocked(spawnOrchestratorProcess).mockClear();
    vi.mocked(classifyPlane).mockResolvedValue({
      kind: 'ours-unready',
      pid: 9001,
      checks: { database: false, warm: true },
    });
    vi.mocked(reclaimPlanePort).mockResolvedValue({
      freed: false,
      killedPid: 9001,
      error: 'port 4319 is still held after stopping pid 9001',
    });

    // Booting anyway would only re-fail as a readiness timeout naming the log
    // rather than the survivor.
    await expect(planeUp()).rejects.toThrow('still held after stopping pid 9001');
    expect(spawnOrchestratorProcess).not.toHaveBeenCalled();
  });

  it('planeUp does not wipe pgdata when the incompatible-stamp teardown fails', async () => {
    const { planeUp } = await import('./plane-manager.js');
    const { planePaths } = await import('./paths.js');
    const paths = planePaths();
    await planeUp();

    // An old on-disk layout: the branch that wipes the Postgres data dir.
    fs.mkdirSync(paths.pgData, { recursive: true });
    fs.writeFileSync(path.join(paths.pgData, 'marker'), 'x');
    fs.writeFileSync(
      paths.stampFile,
      JSON.stringify({
        orchestratorPid: 9001,
        port: 4319,
        pgKind: 'embedded',
        kiciVersion: '0.0.0',
        buildCommit: 'unknown',
        stampVersion: 1,
        mode: 'independent',
      }),
    );
    vi.mocked(classifyPlane).mockResolvedValue({ kind: 'ours-ready', pid: 9001 });
    vi.mocked(reclaimPlanePort).mockResolvedValue({
      freed: false,
      killedPid: 9001,
      error: 'port 4319 is still held after stopping pid 9001',
    });

    await expect(planeUp()).rejects.toThrow('still held');
    // Wiping the data dir under a live Postgres would destroy its storage.
    expect(fs.existsSync(path.join(paths.pgData, 'marker'))).toBe(true);
  });
});
