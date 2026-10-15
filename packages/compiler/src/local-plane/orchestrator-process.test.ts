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
    // A plane-only KICI_* var must NOT leak: the orchestrator refuses unknown KICI_* vars.
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
    expect(spawnOpts.env.KICI_BOOTSTRAP_ADMIN_TOKEN).toBe('kici-local-testtoken');
    expect(spawnOpts.env.KICI_SECRET_KEY).toBe('a'.repeat(64));
    expect(spawnOpts.env.KICI_SCALER_CONFIG_PATH).toBe('/x/scaler.yaml');
    expect(spawnOpts.env.KICI_WEBHOOK_PUBLIC_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Loopback listener and storage base are load-bearing with KICI_AGENT_AUTH=none:
    // a routable listener would hand any host on the network a registered agent.
    expect(spawnOpts.env.KICI_HOST).toBe('127.0.0.1');
    expect(spawnOpts.env.KICI_STORAGE_FS_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Dev-signed identity: local mint and provenance under the non-prod issuer.
    expect(spawnOpts.env.KICI_INDEPENDENT_IDENTITY).toBe('true');
    expect(spawnOpts.env.KICI_DEV_IDENTITY_KEY_FILE).toBe('/x/dev-identity/identity.jwk');
    expect(spawnOpts.env.KICI_PROVENANCE_ISSUER).toBe('kici-local');
    // ONE orchestrator, so no Raft peer. Without this the node defers
    // self-election for the 60s grace period (cluster.electionGracePeriodMs)
    // while /ready answers 200, and `triggerRun`'s own 60s budget expires first.
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
        platformWsUrl: 'wss://platform.example.com/kici/ws',
        platformToken: 'kici_ok_secret',
      },
    });
    expect(res.pid).toBe(5252);
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.env.KICI_MODE).toBe('hybrid');
    expect(spawnOpts.env.KICI_PLATFORM_URL).toBe('wss://platform.example.com/kici/ws');
    expect(spawnOpts.env.KICI_PLATFORM_TOKEN).toBe('kici_ok_secret');
    // Hybrid mints with the orchestrator's own key under the plane's own issuer;
    // the dev-signed identity envs are absent, so the local signer never exists.
    // fails-when: the issuer is dropped, which leaves the attached plane with
    // no mint at all (`ctx.kici.oidc.token()` answers "unknown method").
    expect(spawnOpts.env.KICI_ORCHESTRATOR_PROVENANCE_ISSUER).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(spawnOpts.env.KICI_INDEPENDENT_IDENTITY).toBeUndefined();
    expect(spawnOpts.env.KICI_DEV_IDENTITY_KEY_FILE).toBeUndefined();
    expect(spawnOpts.env.KICI_INDEPENDENT_SECRETS).toBeUndefined();
    expect(spawnOpts.env.KICI_BOOTSTRAP_ADMIN_TOKEN).toBe('kici-local-testtoken');
    expect(spawnOpts.env.KICI_SCALER_CONFIG_PATH).toBe('/x/scaler.yaml');
    // The Platform relay is no Raft peer, so hybrid is single-node too.
    // fails-when: the key is set only on the independent branch
    expect(spawnOpts.env.KICI_CLUSTER_SINGLE_NODE).toBe('true');
  });

  it('spawnOrchestratorProcess returns the pid without waiting for readiness', async () => {
    // No /ready stub: a synchronous return lets the caller stamp the pid first.
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

  /** Deletes rather than writing the string "undefined". */
  function restoreConfigDir(saved: string | undefined): void {
    if (saved === undefined) delete process.env.KICI_CONFIG_DIR;
    else process.env.KICI_CONFIG_DIR = saved;
  }

  /** A fresh config dir with a sparse `size`-byte orchestrator log, so 50 MB costs nothing. */
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
    // fails-when: spawnOrchestratorProcess skips the rotate on a PLANE_LOG_MAX_BYTES + 1
    // log — orchestrator.log.1 never appears and the live log keeps the old bytes.
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
    // breaks-if-wrong: rotating unconditionally would discard the previous boot's
    // log, the debugging history it exists for, on every `kici local up`.
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
    // Only node:child_process is mocked, so readiness runs through the fetch stub.
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
