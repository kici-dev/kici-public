import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSH_TRANSPORT_CAPABILITY } from '@kici-dev/engine';
import {
  createEnsureInitRunnerHandler,
  createPreBootSendHandler,
  createPresignAgentPackageHandler,
  CapabilityDeniedError,
  type BringupApiDeps,
} from './bringup-api.js';

const FRESH = 'box-00007';
const OPS = 'ops-agent-1';

function makeDeps(over: Partial<BringupApiDeps> = {}): {
  deps: BringupApiDeps;
  mints: ReturnType<typeof vi.fn>;
  records: ReturnType<typeof vi.fn>;
  resolveNamed: ReturnType<typeof vi.fn>;
} {
  const mints = vi.fn(async () => ({ token: 'kat_boottoken', id: 'boot-1' }));
  const records = vi.fn(async () => undefined);
  const resolveNamed = vi.fn(async () => 'PRIVATE-KEY-MATERIAL');

  // Registry: ops agent holds ssh-transport by default.
  const opsLabels = new Set<string>([SSH_TRANSPORT_CAPABILITY]);
  const registry = {
    get: vi.fn((id: string) => (id === OPS ? { agentId: OPS, labels: opsLabels } : undefined)),
  };

  const rosterStore = {
    // Fresh box: declared static, never connected → unreachable (not live).
    get: vi.fn(async () => ({
      agent_id: FRESH,
      connected_instance_id: null,
      lifecycle_class: 'static',
      last_seen: new Date(),
    })),
    getReach: vi.fn(async () => ({
      agentId: FRESH,
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 22,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: null,
    })),
    recordStagedVersion: vi.fn(async () => undefined),
  };

  const deps = {
    registry: registry as unknown as BringupApiDeps['registry'],
    rosterStore: rosterStore as unknown as BringupApiDeps['rosterStore'],
    tokenStore: { mintBootstrapToken: mints } as unknown as BringupApiDeps['tokenStore'],
    secretResolver: { resolveNamed } as unknown as BringupApiDeps['secretResolver'],
    accessLog: { record: records } as unknown as BringupApiDeps['accessLog'],
    graceMs: 300_000,
    resolveOrgId: () => '__default__',
    resolveOrchestratorUrl: () => 'ws://10.0.0.1:4000/ws',
    resolveVersion: () => '9.9.9',
    ...over,
  } satisfies BringupApiDeps;

  return { deps, mints, records, resolveNamed };
}

describe('createEnsureInitRunnerHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a caller without ssh-transport and writes a denied access-log row', async () => {
    const { deps, mints, records } = makeDeps();
    const handler = createEnsureInitRunnerHandler(deps);
    await expect(handler('not-ops', { targetAgentId: FRESH })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    expect(mints).not.toHaveBeenCalled();
    expect(records).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'fleet.init_runner.bringup',
        outcome: 'denied',
        actor: { type: 'service_account', id: 'not-ops' },
        target: { type: 'fleet', id: FRESH },
      }),
    );
  });

  it('no-ops when the target already has a live agent', async () => {
    const { deps, mints } = makeDeps();
    (deps.rosterStore.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agent_id: FRESH,
      connected_instance_id: 'orch-A',
      lifecycle_class: 'ephemeral',
      last_seen: new Date(),
    });
    const handler = createEnsureInitRunnerHandler(deps);
    const result = await handler(OPS, { targetAgentId: FRESH });
    expect(result).toEqual({ broughtUp: false });
    expect(mints).not.toHaveBeenCalled();
  });

  it('does NOT no-op (brings up) when the target row is stale / not currently live', async () => {
    // The convergence handoff guard keys on derived `ready`: a declared host
    // whose last_seen is stale (the fresh-box case) is NOT ready, so the
    // bring-up proceeds — this is what makes "runs on all, init-or-not" build a
    // fresh box while re-running against a now-live box no-ops.
    const { deps, mints } = makeDeps();
    (deps.rosterStore.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agent_id: FRESH,
      connected_instance_id: null,
      lifecycle_class: 'static',
      last_seen: new Date(Date.now() - 60 * 60 * 1000),
    });
    const handler = createEnsureInitRunnerHandler(deps);
    const result = await handler(OPS, { targetAgentId: FRESH });
    expect(result.broughtUp).toBe(true);
    expect(mints).toHaveBeenCalled();
  });

  it('mints a single-use token, resolves the key, audits, and returns the material', async () => {
    const { deps, mints, records, resolveNamed } = makeDeps();
    const handler = createEnsureInitRunnerHandler(deps);
    const result = await handler(OPS, { targetAgentId: FRESH });

    expect(resolveNamed).toHaveBeenCalledWith('__default__', 'prod/bootstrap', 'ssh');
    expect(mints).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: FRESH,
        labels: ['kici:init', 'kici:privileged:root', `kici:host:${FRESH}`],
      }),
    );
    expect(result).toMatchObject({
      broughtUp: true,
      privateKey: 'PRIVATE-KEY-MATERIAL',
      bootstrapToken: 'kat_boottoken',
      targetAgentId: FRESH,
      orchestratorUrl: 'ws://10.0.0.1:4000/ws',
      version: '9.9.9',
      reach: { agentId: FRESH, address: '10.0.0.7', sshUser: 'root', sshPort: 22 },
    });
    // Reach returned to the agent never carries the secret ref.
    expect(result.reach).not.toHaveProperty('sshKeySecret');
    expect(records).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'fleet.init_runner.bringup', outcome: 'allowed' }),
    );
  });

  it('throws when the host has no reach address', async () => {
    const { deps } = makeDeps();
    (deps.rosterStore.getReach as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentId: FRESH,
      address: null,
      sshUser: null,
      sshPort: null,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: null,
    });
    const handler = createEnsureInitRunnerHandler(deps);
    await expect(handler(OPS, { targetAgentId: FRESH })).rejects.toThrow(/no SSH reach address/);
  });

  it('defaults deliveryMode to ssh-push when the host is not S3-reachable', async () => {
    const { deps } = makeDeps({ agentPackages: {} as BringupApiDeps['agentPackages'] });
    const result = await createEnsureInitRunnerHandler(deps)(OPS, { targetAgentId: FRESH });
    expect(result.deliveryMode).toBe('ssh-push');
  });

  it('picks s3-direct only when the host is S3-reachable AND a cache store is present', async () => {
    const { deps } = makeDeps({ agentPackages: {} as BringupApiDeps['agentPackages'] });
    (deps.rosterStore.getReach as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentId: FRESH,
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 22,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: true,
    });
    const result = await createEnsureInitRunnerHandler(deps)(OPS, { targetAgentId: FRESH });
    expect(result.deliveryMode).toBe('s3-direct');
  });

  it('falls back to ssh-push even when S3-reachable if no cache store is configured', async () => {
    const { deps } = makeDeps(); // no agentPackages
    (deps.rosterStore.getReach as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentId: FRESH,
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 22,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: true,
    });
    const result = await createEnsureInitRunnerHandler(deps)(OPS, { targetAgentId: FRESH });
    expect(result.deliveryMode).toBe('ssh-push');
  });
});

describe('createPresignAgentPackageHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  function withStore(over: Partial<BringupApiDeps> = {}) {
    const getUrl = vi.fn(async () => 'https://cache/presigned?sig=x');
    const get = vi.fn(async () => Buffer.from(`${'a'.repeat(64)}  kici-agent-linux-x64.tar.gz\n`));
    const has = vi.fn(async () => true);
    return {
      ...makeDeps({ agentPackages: { getUrl, get, has }, ...over }),
      getUrl,
      get,
    };
  }

  it('refuses a caller without ssh-transport (denied + access-logged)', async () => {
    const { deps, records } = withStore();
    await expect(
      createPresignAgentPackageHandler(deps)('not-ops', {
        targetAgentId: FRESH,
        platform: 'linux-x64',
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(records).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('mints a presigned URL + sha256 for the probed platform and audits allowed', async () => {
    const { deps, getUrl, records } = withStore();
    const res = await createPresignAgentPackageHandler(deps)(OPS, {
      targetAgentId: FRESH,
      platform: 'linux-x64',
    });
    expect(res).toEqual({ url: 'https://cache/presigned?sig=x', sha256: 'a'.repeat(64) });
    expect(getUrl).toHaveBeenCalledWith('agent-packages/9.9.9/kici-agent-linux-x64.tar.gz');
    expect(records).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed' }));
  });

  it('throws when no payload object exists for the version (no silent stale stage)', async () => {
    const getUrl = vi.fn(async () => null);
    const { deps } = makeDeps({
      agentPackages: { getUrl, get: vi.fn(), has: vi.fn() },
    });
    await expect(
      createPresignAgentPackageHandler(deps)(OPS, {
        targetAgentId: FRESH,
        platform: 'linux-arm64',
      }),
    ).rejects.toThrow(/no agent payload for version 9\.9\.9/);
  });

  it('refuses when no cache store is configured', async () => {
    const { deps } = makeDeps(); // no agentPackages
    await expect(
      createPresignAgentPackageHandler(deps)(OPS, { targetAgentId: FRESH, platform: 'linux-x64' }),
    ).rejects.toThrow(/object storage is not configured/);
  });
});

describe('createPreBootSendHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the SSH key + input secret, defaults to dropbear port/command, audits', async () => {
    const { deps, resolveNamed, records } = makeDeps();
    // First resolveNamed call = SSH key (prod/bootstrap/ssh); second = input.
    resolveNamed.mockResolvedValueOnce('SSH-KEY').mockResolvedValueOnce('LUKS-PASSPHRASE');
    const handler = createPreBootSendHandler(deps);
    const result = await handler(OPS, {
      targetAgentId: FRESH,
      inputSecret: 'prod/luks/box-00007',
    });

    expect(resolveNamed).toHaveBeenNthCalledWith(1, '__default__', 'prod/bootstrap', 'ssh');
    expect(resolveNamed).toHaveBeenNthCalledWith(2, '__default__', 'prod/luks', 'box-00007');
    expect(result).toEqual({
      reach: { agentId: FRESH, address: '10.0.0.7', sshUser: 'root', sshPort: 22 },
      privateKey: 'SSH-KEY',
      input: 'LUKS-PASSPHRASE',
      port: 2222,
      command: 'cryptroot-unlock',
    });
    expect(records).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'fleet.pre_boot.send', outcome: 'allowed' }),
    );
  });

  it('refuses a caller without ssh-transport', async () => {
    const { deps } = makeDeps();
    const handler = createPreBootSendHandler(deps);
    await expect(
      handler('not-ops', { targetAgentId: FRESH, inputSecret: 'prod/luks/x' }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
