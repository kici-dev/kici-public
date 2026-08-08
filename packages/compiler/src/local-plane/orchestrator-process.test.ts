import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    // Dev-signed identity: local mint + provenance under the non-prod issuer.
    expect(spawnOpts.env.KICI_INDEPENDENT_IDENTITY).toBe('true');
    expect(spawnOpts.env.KICI_DEV_IDENTITY_KEY_FILE).toBe('/x/dev-identity/identity.jwk');
    expect(spawnOpts.env.KICI_PROVENANCE_ISSUER).toBe('kici-local');
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
