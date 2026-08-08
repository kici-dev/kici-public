import { describe, it, expect, vi } from 'vitest';
import { SSH_TRANSPORT_CAPABILITY } from '@kici-dev/engine';
import {
  archToAgentPlatform,
  resolveRestartSpec,
  createAgentVersionStatusHandler,
  createRestageAgentHandler,
  CapabilityDeniedError,
  type BringupApiDeps,
} from './bringup-api.js';
import { agentPackageKey } from '../agent-packaging/upload.js';

const TARGET = 'box-9';
const OPS = 'ops-1';

/** Deps with an agent-package store whose payloads live in `present`. */
function makeDeps(opts: {
  present?: Set<string>;
  platform?: string | null;
  arch?: string | null;
  staged?: string | null;
  properties?: Record<string, unknown>;
  version?: string;
}): {
  deps: BringupApiDeps;
  recordStagedVersion: ReturnType<typeof vi.fn>;
} {
  const present = opts.present ?? new Set<string>();
  const opsLabels = new Set<string>([SSH_TRANSPORT_CAPABILITY]);
  const recordStagedVersion = vi.fn(async () => undefined);
  const rosterStore = {
    get: vi.fn(async () => ({
      agent_id: TARGET,
      platform: opts.platform ?? 'linux',
      arch: opts.arch ?? 'x64',
      host_properties: opts.properties ?? {},
      connected_instance_id: 'inst-1',
      lifecycle_class: 'static',
      last_seen: new Date(),
    })),
    getReach: vi.fn(async () => ({
      agentId: TARGET,
      address: '10.0.0.9',
      sshUser: 'root',
      sshPort: 22,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: null,
    })),
    getStagedVersion: vi.fn(async () => opts.staged ?? null),
    recordStagedVersion,
  };
  const deps = {
    registry: {
      get: vi.fn((id: string) => (id === OPS ? { agentId: OPS, labels: opsLabels } : undefined)),
    } as unknown as BringupApiDeps['registry'],
    rosterStore: rosterStore as unknown as BringupApiDeps['rosterStore'],
    tokenStore: {} as unknown as BringupApiDeps['tokenStore'],
    secretResolver: {
      resolveNamed: vi.fn(async () => 'PRIVATE-KEY'),
    } as unknown as BringupApiDeps['secretResolver'],
    accessLog: { record: vi.fn(async () => undefined) } as unknown as BringupApiDeps['accessLog'],
    graceMs: 300_000,
    resolveOrgId: () => '__default__',
    resolveOrchestratorUrl: () => 'ws://o/ws',
    resolveVersion: () => opts.version ?? '2.0.0',
    agentPackages: {
      getUrl: vi.fn(),
      get: vi.fn(),
      has: vi.fn(async (key: string) => present.has(key)),
    },
  } satisfies BringupApiDeps;
  return { deps, recordStagedVersion };
}

describe('archToAgentPlatform', () => {
  it('maps both uname and node arch spellings', () => {
    expect(archToAgentPlatform('linux', 'x86_64')).toBe('linux-x64');
    expect(archToAgentPlatform('linux', 'x64')).toBe('linux-x64');
    expect(archToAgentPlatform('linux', 'aarch64')).toBe('linux-arm64');
    expect(archToAgentPlatform('linux', 'arm64')).toBe('linux-arm64');
  });
  it('returns null for unknown / non-linux', () => {
    expect(archToAgentPlatform('darwin', 'arm64')).toBeNull();
    expect(archToAgentPlatform('linux', 'riscv')).toBeNull();
    expect(archToAgentPlatform(null, null)).toBeNull();
  });
});

describe('resolveRestartSpec', () => {
  it('prefers explicit stop/start with optional install dir', () => {
    expect(
      resolveRestartSpec({
        'kici:agent-restart-stop': 'stop me',
        'kici:agent-restart-start': 'start me',
        'kici:agent-install-dir': '/opt/x',
      }),
    ).toEqual({ stop: 'stop me', start: 'start me', installDir: '/opt/x' });
  });
  it('falls back to a systemd service name (single-quoted defensively)', () => {
    expect(resolveRestartSpec({ 'kici:agent-service': 'kici-agent' })).toEqual({
      stop: "systemctl --user stop 'kici-agent' || true",
      start: "systemctl --user start 'kici-agent'",
    });
  });
  it('neutralizes a service name that tries to break out of the argv', () => {
    const spec = resolveRestartSpec({ 'kici:agent-service': "x'; rm -rf /; '" })!;
    // The injected quote is escaped, so the whole value stays one argv token.
    expect(spec.start).toBe("systemctl --user start 'x'\\''; rm -rf /; '\\'''");
  });
  it('returns null when neither is declared', () => {
    expect(resolveRestartSpec({})).toBeNull();
  });
});

describe('createAgentVersionStatusHandler', () => {
  it('reports target, staged, and available for the host platform', async () => {
    const { deps } = makeDeps({
      present: new Set([agentPackageKey('2.0.0', 'linux-x64')]),
      staged: '1.0.0',
    });
    const res = await createAgentVersionStatusHandler(deps)(OPS, { targetAgentId: TARGET });
    expect(res).toEqual({ targetVersion: '2.0.0', stagedVersion: '1.0.0', available: true });
  });
  it('reports available:false when the target payload is absent', async () => {
    const { deps } = makeDeps({ present: new Set(), staged: '1.0.0' });
    const res = await createAgentVersionStatusHandler(deps)(OPS, { targetAgentId: TARGET });
    expect(res.available).toBe(false);
  });
  it('denies a caller without ssh-transport', async () => {
    const { deps } = makeDeps({});
    await expect(
      createAgentVersionStatusHandler(deps)('random-agent', { targetAgentId: TARGET }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});

describe('createRestageAgentHandler', () => {
  const props = { 'kici:agent-service': 'kici-agent' };

  it('returns re-stage material + records the staged version for an available target', async () => {
    const { deps, recordStagedVersion } = makeDeps({
      present: new Set([agentPackageKey('2.0.0', 'linux-x64')]),
      properties: props,
      staged: '1.0.0',
    });
    const res = await createRestageAgentHandler(deps)(OPS, { targetAgentId: TARGET });
    expect(res.version).toBe('2.0.0');
    expect(res.privateKey).toBe('PRIVATE-KEY');
    expect(res.restart.start).toContain('systemctl');
    expect(recordStagedVersion).toHaveBeenCalledWith(TARGET, '2.0.0');
  });

  it('REFUSES + does not record when the target payload is unavailable (no skew)', async () => {
    const { deps, recordStagedVersion } = makeDeps({
      present: new Set(), // version 2.0.0 has NO payload
      properties: props,
      staged: '1.0.0',
    });
    await expect(createRestageAgentHandler(deps)(OPS, { targetAgentId: TARGET })).rejects.toThrow(
      /payload unavailable/i,
    );
    expect(recordStagedVersion).not.toHaveBeenCalled();
  });

  it('refuses a host that declares no restart method', async () => {
    const { deps } = makeDeps({
      present: new Set([agentPackageKey('2.0.0', 'linux-x64')]),
      properties: {},
    });
    await expect(createRestageAgentHandler(deps)(OPS, { targetAgentId: TARGET })).rejects.toThrow(
      /no restart method/i,
    );
  });

  it('denies a caller without ssh-transport', async () => {
    const { deps } = makeDeps({ properties: props });
    await expect(
      createRestageAgentHandler(deps)('random', { targetAgentId: TARGET }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
