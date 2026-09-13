import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

describe('spawnOrchestratorProcess / awaitOrchestratorReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('spawns standalone with independent-mode env', async () => {
    spawnMock.mockReturnValue({ pid: 4242, on: vi.fn(), unref: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    // A plane-only KICI_* var in the ambient env must NOT leak to the
    // orchestrator (it refuses to start on unknown KICI_* vars).
    process.env.KICI_LOCAL_PG_MODE = 'podman';
    const mod = await import('./orchestrator-process.js');
    vi.spyOn(mod, 'resolveStandaloneEntry').mockReturnValue('/x/standalone.js');
    const res = mod.spawnOrchestratorProcess('postgres://kici:kici@127.0.0.1:45432/kici_local', {
      adminToken: 'kici-local-testtoken',
      secretKey: 'a'.repeat(64),
      scalerConfigFile: '/x/scaler.yaml',
      devIdentityKeyFile: '/x/dev-identity/identity.jwk',
    });
    delete process.env.KICI_LOCAL_PG_MODE;
    expect(res.pid).toBe(4242);
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.env.KICI_MODE).toBe('independent');
    expect(spawnOpts.env.KICI_AGENT_AUTH).toBe('none');
    expect(spawnOpts.env.KICI_DATABASE_URL).toContain('kici_local');
    expect(spawnOpts.env.KICI_LOCAL_PG_MODE).toBeUndefined();
    // The plane's admin token + bare-metal scaler are threaded into the boot.
    expect(spawnOpts.env.KICI_BOOTSTRAP_ADMIN_TOKEN).toBe('kici-local-testtoken');
    expect(spawnOpts.env.KICI_SECRET_KEY).toBe('a'.repeat(64));
    expect(spawnOpts.env.KICI_SCALER_CONFIG_PATH).toBe('/x/scaler.yaml');
    expect(spawnOpts.env.KICI_WEBHOOK_PUBLIC_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The plane binds loopback, and its storage base is loopback too. Both are
    // load-bearing alongside KICI_AGENT_AUTH=none above: a routable listener
    // with agent auth disabled hands any host on the network a registered agent.
    expect(spawnOpts.env.KICI_HOST).toBe('127.0.0.1');
    expect(spawnOpts.env.KICI_STORAGE_FS_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Dev-signed identity: local mint + provenance under the non-prod issuer.
    expect(spawnOpts.env.KICI_INDEPENDENT_IDENTITY).toBe('true');
    expect(spawnOpts.env.KICI_DEV_IDENTITY_KEY_FILE).toBe('/x/dev-identity/identity.jwk');
    expect(spawnOpts.env.KICI_PROVENANCE_ISSUER).toBe('kici-local');
    // The plane runs exactly ONE orchestrator process, so Raft has no peer to
    // wait for. Without this the node defers self-election for the default 60s
    // grace period (config.ts cluster.electionGracePeriodMs) while /ready
    // already answers 200 — and `triggerRun`'s own 60s budget expires first.
    // fails-when: the key is dropped from the env block
    expect(spawnOpts.env.KICI_CLUSTER_SINGLE_NODE).toBe('true');
  });

  it('spawns the server entry with hybrid-mode env when attaching to the Platform', async () => {
    spawnMock.mockReturnValue({ pid: 5252, on: vi.fn(), unref: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const mod = await import('./orchestrator-process.js');
    vi.spyOn(mod, 'resolveServerEntry').mockReturnValue('/x/server.js');
    const res = mod.spawnOrchestratorProcess('postgres://kici:kici@127.0.0.1:45432/kici_local', {
      adminToken: 'kici-local-testtoken',
      secretKey: 'a'.repeat(64),
      scalerConfigFile: '/x/scaler.yaml',
      attach: {
        platformWsUrl: 'wss://thinker1.dev.kici.dev/kici-stg/ws',
        platformToken: 'kici_ok_secret',
      },
    });
    expect(res.pid).toBe(5252);
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.env.KICI_MODE).toBe('hybrid');
    expect(spawnOpts.env.KICI_PLATFORM_URL).toBe('wss://thinker1.dev.kici.dev/kici-stg/ws');
    expect(spawnOpts.env.KICI_PLATFORM_TOKEN).toBe('kici_ok_secret');
    // Hybrid mints via the Platform relay — the dev-signed identity envs are
    // deliberately absent so the local signer is never even configured.
    expect(spawnOpts.env.KICI_INDEPENDENT_IDENTITY).toBeUndefined();
    expect(spawnOpts.env.KICI_DEV_IDENTITY_KEY_FILE).toBeUndefined();
    expect(spawnOpts.env.KICI_INDEPENDENT_SECRETS).toBeUndefined();
    // Common config still present.
    expect(spawnOpts.env.KICI_BOOTSTRAP_ADMIN_TOKEN).toBe('kici-local-testtoken');
    expect(spawnOpts.env.KICI_SCALER_CONFIG_PATH).toBe('/x/scaler.yaml');
    // Attaching to the Platform relay adds no Raft coordinator peer, so the
    // hybrid boot is single-node too.
    // fails-when: the key is set only on the independent branch
    expect(spawnOpts.env.KICI_CLUSTER_SINGLE_NODE).toBe('true');
  });

  it('spawnOrchestratorProcess returns the pid without waiting for readiness', async () => {
    // No /ready stub at all; a synchronous return proves the caller can stamp
    // the pid before the readiness wait begins.
    spawnMock.mockReturnValue({ pid: 4242, on: vi.fn(), unref: vi.fn() });
    const mod = await import('./orchestrator-process.js');
    vi.spyOn(mod, 'resolveStandaloneEntry').mockReturnValue('/x/standalone.js');
    const result = mod.spawnOrchestratorProcess('postgres://x', {
      adminToken: 'kici-local-testtoken',
      secretKey: 'a'.repeat(64),
      scalerConfigFile: '/x/scaler.yaml',
      devIdentityKeyFile: '/x/id.jwk',
    });
    expect(result.pid).toBe(4242);
    expect(result.port).toBe(4319);
  });

  /** Restore KICI_CONFIG_DIR, deleting it rather than writing the string "undefined". */
  function restoreConfigDir(saved: string | undefined): void {
    if (saved === undefined) delete process.env.KICI_CONFIG_DIR;
    else process.env.KICI_CONFIG_DIR = saved;
  }

  /**
   * Point the plane at a fresh config dir and seed its orchestrator log at
   * `size` bytes (sparse, so the 50 MB case costs nothing).
   */
  async function seedPlaneLog(size: number): Promise<{ dir: string; logFile: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-orchlog-'));
    process.env.KICI_CONFIG_DIR = dir;
    const { planePaths } = await import('./paths.js');
    const { logFile, root } = planePaths();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(logFile, '');
    fs.truncateSync(logFile, size);
    return { dir, logFile };
  }

  it('rotates an over-cap plane log before opening a fresh one', async () => {
    // fails-when: the plane log is already PLANE_LOG_MAX_BYTES + 1 bytes. With
    // the rotate call removed from spawnOrchestratorProcess, orchestrator.log.1
    // never appears and the live log still carries the old bytes.
    const saved = process.env.KICI_CONFIG_DIR;
    const { PLANE_LOG_MAX_BYTES } = await import('./plane-log.js');
    const { dir, logFile } = await seedPlaneLog(PLANE_LOG_MAX_BYTES + 1);
    try {
      spawnMock.mockReturnValue({ pid: 4242, on: vi.fn(), unref: vi.fn() });
      const mod = await import('./orchestrator-process.js');
      vi.spyOn(mod, 'resolveStandaloneEntry').mockReturnValue('/x/standalone.js');
      mod.spawnOrchestratorProcess('postgres://x', {
        adminToken: 'kici-local-testtoken',
        secretKey: 'a'.repeat(64),
        scalerConfigFile: '/x/scaler.yaml',
        devIdentityKeyFile: '/x/id.jwk',
      });
      expect(fs.statSync(`${logFile}.1`).size).toBe(PLANE_LOG_MAX_BYTES + 1);
      expect(fs.statSync(logFile).size).toBe(0);
    } finally {
      restoreConfigDir(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an under-cap plane log alone, so a boot keeps its history', async () => {
    // breaks-if-wrong: the common case is a small log. Rotating unconditionally
    // would throw away the previous boot's log on every `kici local up`, which
    // is exactly the debugging history the log exists to provide.
    const saved = process.env.KICI_CONFIG_DIR;
    const { dir, logFile } = await seedPlaneLog(0);
    try {
      fs.writeFileSync(logFile, 'previous boot\n');
      spawnMock.mockReturnValue({ pid: 4242, on: vi.fn(), unref: vi.fn() });
      const mod = await import('./orchestrator-process.js');
      vi.spyOn(mod, 'resolveStandaloneEntry').mockReturnValue('/x/standalone.js');
      mod.spawnOrchestratorProcess('postgres://x', {
        adminToken: 'kici-local-testtoken',
        secretKey: 'a'.repeat(64),
        scalerConfigFile: '/x/scaler.yaml',
        devIdentityKeyFile: '/x/id.jwk',
      });
      expect(fs.existsSync(`${logFile}.1`)).toBe(false);
      expect(fs.readFileSync(logFile, 'utf-8')).toBe('previous boot\n');
    } finally {
      restoreConfigDir(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('awaitOrchestratorReady throws once the attempts are exhausted', async () => {
    // This file mocks only node:child_process, so readiness is driven through
    // the same global fetch stub the env-assertion cases use.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const mod = await import('./orchestrator-process.js');
    await expect(mod.awaitOrchestratorReady(4319, 2, 1)).rejects.toThrow(
      'local orchestrator did not become ready',
    );
  });

  it('awaitOrchestratorReady resolves as soon as /ready answers 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const mod = await import('./orchestrator-process.js');
    await expect(mod.awaitOrchestratorReady(4319, 2, 1)).resolves.toBeUndefined();
  });
});
