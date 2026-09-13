import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Docker from 'dockerode';

const mockValidate = vi.fn().mockResolvedValue(undefined);
const mockEnsureTable = vi.fn().mockResolvedValue(undefined);
const mockAddRules = vi.fn().mockResolvedValue(undefined);
const mockRemoveRules = vi.fn().mockResolvedValue(undefined);
const mockAddHostRules = vi.fn().mockResolvedValue(undefined);
/** Null by default: the input chain does not exist yet, so the baseline installs. */
const mockReadInputChain = vi.fn().mockResolvedValue(null);
/** Empty chain by default: the subnet has no rules yet, so the baseline installs. */
const mockReadChain = vi.fn().mockResolvedValue('table ip kici {\n chain forward {\n }\n}\n');

vi.mock('@kici-dev/shared/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared/net')>()),
  validateNftablesAvailability: (...a: unknown[]) => mockValidate(...a),
  ensureKiciTable: (...a: unknown[]) => mockEnsureTable(...a),
  addIsolationRules: (...a: unknown[]) => mockAddRules(...a),
  removeIsolationRules: (...a: unknown[]) => mockRemoveRules(...a),
  readForwardChain: (...a: unknown[]) => mockReadChain(...a),
  addHostIsolationRules: (...a: unknown[]) => mockAddHostRules(...a),
  readInputChain: (...a: unknown[]) => mockReadInputChain(...a),
}));

/**
 * A `forward` chain already carrying the subnet drop set, as `nft -a list
 * chain` prints it. Verbatim nft output, because the presence check parses it.
 */
const CHAIN_WITH_SUBNET_RULES = [
  'table ip kici {',
  '\tchain forward {',
  '\t\ttype filter hook forward priority filter; policy accept;',
  '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 accept # handle 11',
  '\t\tip saddr 172.31.0.0/16 ip daddr 10.0.0.0/8 drop # handle 12',
  '\t\tip saddr 172.31.0.0/16 ip daddr 172.16.0.0/12 drop # handle 13',
  '\t\tip saddr 172.31.0.0/16 ip daddr 192.168.0.0/16 drop # handle 14',
  '\t\tip saddr 172.31.0.0/16 ip daddr 169.254.0.0/16 drop # handle 15',
  '\t}',
  '}',
].join('\n');

function fakeDocker(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listNetworks: vi.fn().mockResolvedValue([]),
    createNetwork: vi.fn().mockResolvedValue({ id: 'net-1' }),
    getContainer: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        NetworkSettings: { Networks: { 'kici-jobs': { IPAddress: '172.31.0.7' } } },
      }),
    }),
    ...overrides,
  } as unknown as Docker;
}

describe('job-network', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadChain.mockResolvedValue('table ip kici {\n chain forward {\n }\n}\n');
  });

  it('creates the kici-jobs bridge and reports filtering active', async () => {
    const { ensureJobNetwork, JOB_NETWORK_NAME, JOB_NETWORK_SUBNET } =
      await import('./job-network.js');
    const docker = fakeDocker();

    expect(await ensureJobNetwork(docker)).toBe(true);

    const createArg = (docker.createNetwork as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArg.Name).toBe(JOB_NETWORK_NAME);
    expect(createArg.IPAM.Config[0].Subnet).toBe(JOB_NETWORK_SUBNET);
    expect(mockEnsureTable).toHaveBeenCalled();
  });

  it('installs the subnet drop set before the bridge itself exists', async () => {
    const { ensureJobNetwork, JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY } =
      await import('./job-network.js');
    const docker = fakeDocker();

    expect(await ensureJobNetwork(docker)).toBe(true);

    // Keyed on the subnet, not on a container address: that is what makes the
    // rules cover a container the agent has not created yet.
    expect(mockAddRules).toHaveBeenCalledWith(
      JOB_NETWORK_SUBNET,
      JOB_NETWORK_GATEWAY,
      undefined,
      'saddr',
    );

    // Ordering is the property under test. The rules must be in the chain
    // before anything can join the bridge, so they land before the bridge is
    // even created — and a container can only ever be created after that.
    const createNetwork = docker.createNetwork as ReturnType<typeof vi.fn>;
    expect(mockAddRules.mock.invocationCallOrder[0]).toBeLessThan(
      createNetwork.mock.invocationCallOrder[0],
    );
  });

  it('installs the drop set when the forward chain does not exist yet', async () => {
    // `readForwardChain` answers null for a table whose chain nft has not
    // created. "No chain" means no rules are installed, so the drops must go
    // in — reading it as "already covered" would put every job container on
    // the bridge unfiltered.
    const { ensureJobNetwork, JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY } =
      await import('./job-network.js');
    mockReadChain.mockResolvedValue(null);

    expect(await ensureJobNetwork(fakeDocker())).toBe(true);

    expect(mockAddRules).toHaveBeenCalledWith(
      JOB_NETWORK_SUBNET,
      JOB_NETWORK_GATEWAY,
      undefined,
      'saddr',
    );
  });

  it('does not reinstall the subnet drop set on a later job', async () => {
    mockReadChain.mockResolvedValue(CHAIN_WITH_SUBNET_RULES);
    const { ensureJobNetwork } = await import('./job-network.js');

    expect(await ensureJobNetwork(fakeDocker())).toBe(true);
    // ensureJobNetwork runs once per job, so an unconditional install would
    // leak a whole rule set per job.
    expect(mockAddRules).not.toHaveBeenCalled();
  });

  it('reinstalls the drop set when the chain carries only part of it', async () => {
    // The install is five separate `nft insert` calls, so a failure or a kill
    // part-way through leaves exactly this: the gateway accept and the metadata
    // drop landed, the three RFC1918 drops did not. Skipping on the first match
    // would leave every later job on the host behind partial filtering, with
    // 10.0.0.0/8 reachable and nothing to heal it.
    mockReadChain.mockResolvedValue(
      [
        'table ip kici {',
        '\tchain forward {',
        '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 accept # handle 11',
        '\t\tip saddr 172.31.0.0/16 ip daddr 169.254.0.0/16 drop # handle 12',
        '\t}',
        '}',
      ].join('\n'),
    );
    const { ensureJobNetwork, JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY } =
      await import('./job-network.js');

    expect(await ensureJobNetwork(fakeDocker())).toBe(true);
    expect(mockAddRules).toHaveBeenCalledWith(
      JOB_NETWORK_SUBNET,
      JOB_NETWORK_GATEWAY,
      undefined,
      'saddr',
    );
  });

  it('installs the drop set even when the chain only mentions the subnet elsewhere', async () => {
    // Neither line covers the job subnet as a SOURCE, and the scaler writes
    // both shapes into this same chain: a per-container rule whose address
    // shares the subnet's text prefix, and an operator allowlist naming the
    // subnet as a destination. A looser presence check reads either as "already
    // covered" and leaves every job container unfiltered.
    mockReadChain.mockResolvedValue(
      [
        'table ip kici {',
        '\tchain forward {',
        '\t\tip saddr 172.31.0.10 ip daddr 10.0.0.0/8 drop # handle 21',
        '\t\tip saddr 172.30.0.4 ip daddr 172.31.0.0/16 accept # handle 22',
        '\t}',
        '}',
      ].join('\n'),
    );
    const { ensureJobNetwork, JOB_NETWORK_SUBNET } = await import('./job-network.js');

    expect(await ensureJobNetwork(fakeDocker())).toBe(true);
    expect(mockAddRules).toHaveBeenCalledWith(
      JOB_NETWORK_SUBNET,
      expect.anything(),
      undefined,
      'saddr',
    );
  });

  it('refuses the bridge when the subnet rules cannot be installed', async () => {
    mockAddRules.mockRejectedValueOnce(new Error('nft: Operation not permitted'));
    const { ensureJobNetwork } = await import('./job-network.js');
    const docker = fakeDocker();

    // Same degradation the table check already has: no rules means no bridge,
    // so a job container never joins a network whose filtering is absent.
    expect(await ensureJobNetwork(docker)).toBe(false);
    expect(docker.createNetwork).not.toHaveBeenCalled();
  });

  it('installs no rules at all when nft is unavailable', async () => {
    mockValidate.mockRejectedValueOnce(new Error('nftables binary not found at /usr/sbin/nft.'));
    const { ensureJobNetwork } = await import('./job-network.js');

    expect(await ensureJobNetwork(fakeDocker())).toBe(false);
    expect(mockReadChain).not.toHaveBeenCalled();
    expect(mockAddRules).not.toHaveBeenCalled();
  });

  it('reuses an existing network', async () => {
    const { ensureJobNetwork } = await import('./job-network.js');
    const docker = fakeDocker({
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'kici-jobs', Id: 'net-1' }]),
    });

    await ensureJobNetwork(docker);
    expect(docker.createNetwork).not.toHaveBeenCalled();
  });

  it('keys the drops on an existing network’s own subnet when it differs', async () => {
    const { ensureJobNetwork } = await import('./job-network.js');
    // A `kici-jobs` bridge somebody else made. A container on it gets a
    // 10.77.x address, which the canonical 172.31.0.0/16 set never matches —
    // so keying only on the constant would leave the whole bridge unfiltered
    // and reopen the pre-start window this module exists to close.
    const docker = fakeDocker({
      listNetworks: vi.fn().mockResolvedValue([
        {
          Name: 'kici-jobs',
          Id: 'net-1',
          IPAM: { Config: [{ Subnet: '10.77.0.0/16', Gateway: '10.77.0.1' }] },
        },
      ]),
    });

    expect(await ensureJobNetwork(docker)).toBe(true);
    expect(mockAddRules).toHaveBeenCalledWith('10.77.0.0/16', '10.77.0.1', undefined, 'saddr');
  });

  it('installs one set when an existing network carries the expected subnet', async () => {
    const { ensureJobNetwork, JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY } =
      await import('./job-network.js');
    const docker = fakeDocker({
      listNetworks: vi.fn().mockResolvedValue([
        {
          Name: 'kici-jobs',
          Id: 'net-1',
          IPAM: { Config: [{ Subnet: JOB_NETWORK_SUBNET, Gateway: JOB_NETWORK_GATEWAY }] },
        },
      ]),
    });

    // The ordinary path must not pay for the anomaly above with a second
    // install keyed on the same range.
    expect(await ensureJobNetwork(docker)).toBe(true);
    expect(mockAddRules).toHaveBeenCalledTimes(1);
  });

  it('tolerates a concurrent creator (409)', async () => {
    const { ensureJobNetwork } = await import('./job-network.js');
    const docker = fakeDocker({
      createNetwork: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 })),
    });

    expect(await ensureJobNetwork(docker)).toBe(true);
  });

  it('warns and degrades when nft is unavailable rather than refusing to run', async () => {
    mockValidate.mockRejectedValueOnce(new Error('nftables binary not found at /usr/sbin/nft.'));
    const { ensureJobNetwork } = await import('./job-network.js');

    expect(await ensureJobNetwork(fakeDocker())).toBe(false);
    expect(mockEnsureTable).not.toHaveBeenCalled();
  });

  it('keys the egress rules on the container IP and drops the metadata range', async () => {
    const { applyJobEgressRules, JOB_NETWORK_GATEWAY } = await import('./job-network.js');
    const docker = fakeDocker();

    expect(await applyJobEgressRules(docker, 'c1', undefined)).toBe('172.31.0.7');
    expect(mockAddRules).toHaveBeenCalledWith(
      '172.31.0.7',
      JOB_NETWORK_GATEWAY,
      undefined,
      'saddr',
    );
  });

  it('reports no IP rather than throwing when the container has none', async () => {
    const { applyJobEgressRules } = await import('./job-network.js');
    const docker = fakeDocker({
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ NetworkSettings: { Networks: {} } }),
      }),
    });

    expect(await applyJobEgressRules(docker, 'c1', undefined)).toBeUndefined();
    expect(mockAddRules).not.toHaveBeenCalled();
  });

  it('never throws out of teardown when rule removal fails', async () => {
    mockRemoveRules.mockRejectedValueOnce(new Error('nft gone'));
    const { removeJobEgressRules } = await import('./job-network.js');

    await expect(removeJobEgressRules('172.31.0.7')).resolves.toBeUndefined();
  });

  it('is a no-op when no rules were applied', async () => {
    const { removeJobEgressRules } = await import('./job-network.js');
    await removeJobEgressRules(undefined);
    expect(mockRemoveRules).not.toHaveBeenCalled();
  });
});

describe('job-container host boundary', () => {
  beforeEach(() => {
    mockValidate.mockReset().mockResolvedValue(undefined);
    mockEnsureTable.mockReset().mockResolvedValue(undefined);
    mockAddRules.mockReset().mockResolvedValue(undefined);
    mockRemoveRules.mockReset().mockResolvedValue(undefined);
    mockAddHostRules.mockReset().mockResolvedValue(undefined);
    mockReadInputChain.mockReset().mockResolvedValue(null);
    mockReadChain.mockReset().mockResolvedValue('table ip kici {\n chain forward {\n }\n}\n');
  });

  it('grants DNS on the gateway and nothing else on the host', async () => {
    const { applyJobEgressRules } = await import('./job-network.js');
    await applyJobEgressRules(fakeDocker(), 'c1', undefined);

    expect(mockAddHostRules).toHaveBeenCalledWith('172.31.0.7', ['172.31.0.1:53'], 'saddr');
  });

  it('emits the DNS accept above the terminal drop, and no accept for any other port', async () => {
    // The rule text is what the boundary IS, so it is asserted rather than the
    // fact that some call happened. An agent WS port on a host address matches
    // no accept and falls through to the drop.
    const { resolveJobHostAccess } = await import('./job-network.js');
    const { buildHostAccessRuleOps } = await import('@kici-dev/shared/net');
    const rules = buildHostAccessRuleOps(['ip', 'saddr', '172.31.0.0/16'], resolveJobHostAccess());

    expect(rules).toEqual([
      ['ip', 'saddr', '172.31.0.0/16', 'ct', 'state', 'established,related', 'accept'],
      ['ip', 'saddr', '172.31.0.0/16', 'ip', 'daddr', '172.31.0.1', 'tcp', 'dport', '53', 'accept'],
      ['ip', 'saddr', '172.31.0.0/16', 'ip', 'daddr', '172.31.0.1', 'udp', 'dport', '53', 'accept'],
      ['ip', 'saddr', '172.31.0.0/16', 'drop'],
    ]);
    expect(rules.some((r) => r.includes('10143'))).toBe(false);
  });

  it('ignores a hostAccess on the policy it is handed, so no caller can widen the host boundary', async () => {
    // The check that fails if the resolution ever reads its caller: the policy
    // below asks for every port on every host address, which is the whole
    // boundary. `resolveJobHostAccess` takes no policy at all, so the agent
    // default is what lands — assert it through the real call path, since that
    // is where a future per-job policy would arrive.
    const { applyJobEgressRules } = await import('./job-network.js');
    await applyJobEgressRules(fakeDocker(), 'c1', {
      hostAccess: ['*'],
      allowlist: ['10.0.0.0/8'],
      denyAll: true,
    });

    expect(mockAddHostRules).toHaveBeenCalledWith('172.31.0.7', ['172.31.0.1:53'], 'saddr');
    // The forward-hook policy IS the caller's, which is the half it governs.
    expect(mockAddRules).toHaveBeenCalledWith(
      '172.31.0.7',
      '172.31.0.1',
      expect.objectContaining({ denyAll: true }),
      'saddr',
    );
  });

  it('installs the subnet-wide host rules before any container exists', async () => {
    const { ensureJobNetwork } = await import('./job-network.js');
    await ensureJobNetwork(fakeDocker());

    expect(mockAddHostRules).toHaveBeenCalledWith('172.31.0.0/16', ['172.31.0.1:53'], 'saddr');
  });

  it('skips the subnet-wide install when the input chain already carries it', async () => {
    // Re-installing would take the drop away from every running job container
    // for the length of the remove-then-insert.
    mockReadInputChain.mockResolvedValue(
      [
        'table ip kici {',
        '\tchain input {',
        '\t\ttype filter hook input priority filter; policy accept;',
        '\t\tip saddr 172.31.0.0/16 ct state established,related accept # handle 20',
        '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 tcp dport 53 accept # handle 21',
        '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 udp dport 53 accept # handle 22',
        '\t\tip saddr 172.31.0.0/16 drop # handle 23',
        '\t}',
        '}',
      ].join('\n'),
    );
    const { ensureJobNetwork } = await import('./job-network.js');
    await ensureJobNetwork(fakeDocker());

    expect(mockAddHostRules).not.toHaveBeenCalled();
  });

  it('repairs a partial subnet-wide set', async () => {
    // One accept present and the drop missing reads as covered under a
    // first-match check, and every later job joins the bridge unfiltered.
    mockReadInputChain.mockResolvedValue(
      [
        'table ip kici {',
        '\tchain input {',
        '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 tcp dport 53 accept # handle 21',
        '\t}',
        '}',
      ].join('\n'),
    );
    const { ensureJobNetwork } = await import('./job-network.js');
    await ensureJobNetwork(fakeDocker());

    expect(mockAddHostRules).toHaveBeenCalled();
  });
});
