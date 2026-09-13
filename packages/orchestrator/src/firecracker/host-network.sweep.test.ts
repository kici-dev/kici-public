import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListForwardRules = vi.fn();
const mockReadForwardChain = vi.fn();
const mockDeleteForwardRules = vi.fn();

vi.mock('@kici-dev/shared/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared/net')>()),
  listForwardRules: (...a: unknown[]) => mockListForwardRules(...a),
  readForwardChain: (...a: unknown[]) => mockReadForwardChain(...a),
  deleteForwardRules: (...a: unknown[]) => mockDeleteForwardRules(...a),
}));

const cfg = {
  bridgeName: 'kici-br0',
  bridgeCidr: '10.0.0.1/24',
  table: 'kici',
  hostIface: 'eth0',
};

/**
 * A forward chain on a host that runs BOTH a Firecracker orchestrator and a
 * container-mode agent. Verbatim `nft -a list chain` output, because the sparing
 * check parses it.
 *
 * Handles 40–44 are the agent's job-subnet drop set. nft reports their source as
 * a prefix object, so `listForwardRules` reports no per-agent identifier for
 * them — the same answer it gives for the provisioner's own rules, which is
 * exactly why they need sparing by name.
 */
const CHAIN = [
  'table ip kici {',
  '\tchain forward { # handle 3',
  '\t\ttype filter hook forward priority filter; policy accept;',
  '\t\tip saddr 172.31.0.0/16 ip daddr 172.31.0.1 accept # handle 40',
  '\t\tip saddr 172.31.0.0/16 ip daddr 10.0.0.0/8 drop # handle 41',
  '\t\tip saddr 172.31.0.0/16 ip daddr 172.16.0.0/12 drop # handle 42',
  '\t\tip saddr 172.31.0.0/16 ip daddr 192.168.0.0/16 drop # handle 43',
  '\t\tip saddr 172.31.0.0/16 ip daddr 169.254.0.0/16 drop # handle 44',
  '\t\tip saddr 10.0.0.5 ip daddr 10.0.0.1 accept # handle 50',
  '\t\tiifname "kici-br0" ip daddr 10.0.0.0/8 drop # handle 60',
  '\t\tjump baseline # handle 61',
  '\t}',
  '}',
].join('\n');

/** What `listForwardRules` reports for {@link CHAIN}. */
const LISTING = [
  { handle: 40, identifier: null },
  { handle: 41, identifier: null },
  { handle: 42, identifier: null },
  { handle: 43, identifier: null },
  { handle: 44, identifier: null },
  { handle: 50, identifier: '10.0.0.5' },
  { handle: 60, identifier: null },
  { handle: 61, identifier: null },
];

describe('sweepUnownedForwardRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteForwardRules.mockImplementation((handles: number[]) => handles.length);
  });

  it("spares the agent's job-subnet drop set and sweeps the rest", async () => {
    mockListForwardRules.mockResolvedValue(LISTING);
    mockReadForwardChain.mockResolvedValue(CHAIN);
    const { sweepUnownedForwardRules } = await import('./host-network.js');

    expect(await sweepUnownedForwardRules(cfg)).toBe(2);

    // The provisioner's own rules go; the five job-subnet rules stay. Reaping
    // them would leave every job container running at that moment with no
    // egress filtering until the next job reinstalled the set.
    expect(mockDeleteForwardRules).toHaveBeenCalledWith([60, 61], expect.anything());
  });

  it('sweeps nothing when the chain text cannot be read', async () => {
    // `readForwardChain` answers null for a chain it cannot read, including one
    // that is not there at all.
    mockListForwardRules.mockResolvedValue(LISTING);
    mockReadForwardChain.mockResolvedValue(null);
    const { sweepUnownedForwardRules } = await import('./host-network.js');

    // The spared set is unknown, and an unclassified rule in a chain carrying a
    // security control is the wrong direction to guess in.
    expect(await sweepUnownedForwardRules(cfg)).toBe(0);
    expect(mockDeleteForwardRules).not.toHaveBeenCalled();
  });

  it('never reads the chain text when nothing is a candidate', async () => {
    mockListForwardRules.mockResolvedValue([{ handle: 50, identifier: '10.0.0.5' }]);
    const { sweepUnownedForwardRules } = await import('./host-network.js');

    expect(await sweepUnownedForwardRules(cfg)).toBe(0);
    expect(mockReadForwardChain).not.toHaveBeenCalled();
    expect(mockDeleteForwardRules).not.toHaveBeenCalled();
  });
});
