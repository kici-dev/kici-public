import { describe, it, expect } from 'vitest';
import {
  verifyBridge,
  postroutingMasqueradesSubnet,
  baselineHoldsBridgeRules,
  type CommandSpec,
  type FirecrackerBridgeConfig,
} from './host-network.js';

/*
 * Verbatim `nft -j list chain` output (nftables 1.1.3) from a host running two
 * Firecracker bridges. `kici_b` is coordinator B's table, provisioned by
 * `buildBridgeCommands` for 10.0.1.1/24. `kici` is coordinator A's table
 * (10.0.0.1/24) after a second orchestrator provisioned its own bridge
 * (10.98.0.1/24) into it: the flush-and-refill replaced A's NAT and baseline
 * with the other subnet's. Every VM on A's bridge then has no internet access,
 * while the bridge, its address, the table and the tail jump are all intact.
 */
const B_POSTROUTING = `{"nftables": [{"metainfo": {"version": "1.1.3", "release_name": "Commodore Bullmoose #4", "json_schema_version": 1}}, {"chain": {"family": "ip", "table": "kici_b", "name": "postrouting", "handle": 1, "type": "nat", "hook": "postrouting", "prio": 100, "policy": "accept"}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "postrouting", "handle": 2238, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": "enp1s0f0"}}, {"masquerade": null}]}}]}`;

const B_BASELINE = `{"nftables": [{"metainfo": {"version": "1.1.3", "release_name": "Commodore Bullmoose #4", "json_schema_version": 1}}, {"chain": {"family": "ip", "table": "kici_b", "name": "baseline", "handle": 13}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2239, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": "10.0.1.1"}}, {"accept": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2240, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "10.0.0.0", "len": 8}}}}, {"drop": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2241, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "172.16.0.0", "len": 12}}}}, {"drop": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2242, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "192.168.0.0", "len": 16}}}}, {"drop": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2243, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "169.254.0.0", "len": 16}}}}, {"drop": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2244, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "kici-*"}}, {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": "enp1s0f0"}}, {"accept": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2245, "expr": [{"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "enp1s0f0"}}, {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": "kici-*"}}, {"match": {"op": "in", "left": {"ct": {"key": "state"}}, "right": ["established", "related"]}}, {"accept": null}]}}, {"rule": {"family": "ip", "table": "kici_b", "chain": "baseline", "handle": 2246, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.1.0", "len": 24}}}}, {"match": {"op": "==", "left": {"&": [{"payload": {"protocol": "tcp", "field": "flags"}}, {"|": ["syn", "rst"]}]}, "right": "syn"}}, {"mangle": {"key": {"tcp option": {"name": "maxseg", "field": "size"}}, "value": 1460}}]}}]}`;

const A_POSTROUTING_CLOBBERED = `{"nftables": [{"metainfo": {"version": "1.1.3", "release_name": "Commodore Bullmoose #4", "json_schema_version": 1}}, {"chain": {"family": "ip", "table": "kici", "name": "postrouting", "handle": 1, "type": "nat", "hook": "postrouting", "prio": 100, "policy": "accept"}}, {"rule": {"family": "ip", "table": "kici", "chain": "postrouting", "handle": 4029, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.98.0.0", "len": 24}}}}, {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": "enp1s0f0"}}, {"masquerade": null}]}}]}`;

/** Coordinator A's baseline after the clobber: the same shape, for 10.98.0.0/24. */
const A_BASELINE_CLOBBERED = B_BASELINE.replaceAll('kici_b', 'kici')
  .replaceAll('10.0.1.0', '10.98.0.0')
  .replaceAll('10.0.1.1', '10.98.0.1');

const cfgB: FirecrackerBridgeConfig = {
  bridgeName: 'kici-br1',
  bridgeCidr: '10.0.1.1/24',
  table: 'kici_b',
};

const cfgA: FirecrackerBridgeConfig = {
  bridgeName: 'kici-br0',
  bridgeCidr: '10.0.0.1/24',
  table: 'kici',
};

/** Rewrite a listing's rules to keep only those `keep` accepts, preserving order. */
function filterRules(listing: string, keep: (rule: { handle: number }) => boolean): string {
  const parsed = JSON.parse(listing) as { nftables: Array<{ rule?: { handle: number } }> };
  return JSON.stringify({
    nftables: parsed.nftables.filter((e) => e.rule === undefined || keep(e.rule)),
  });
}

describe('postroutingMasqueradesSubnet', () => {
  it('finds the masquerade a provisioned bridge carries for its own subnet', () => {
    // breaks-if-wrong: a correctly provisioned table must keep reading as NATed.
    expect(postroutingMasqueradesSubnet(B_POSTROUTING, '10.0.1.0/24')).toBe(true);
  });

  it('does not count a masquerade that serves a different subnet', () => {
    // fails-when: another bridge's provision replaced this table's NAT.
    expect(postroutingMasqueradesSubnet(A_POSTROUTING_CLOBBERED, '10.0.0.0/24')).toBe(false);
  });

  it('reads an address match with no operator as equality, and a negated one as no match', () => {
    // nft writes `"op": "=="` for an address match. The parser reads a match
    // without an operator as equality, and `!=` names every source except the
    // subnet.
    const noOp = B_POSTROUTING.replaceAll('"op": "==", ', '');
    expect(noOp).not.toContain('"op"');
    expect(postroutingMasqueradesSubnet(noOp, '10.0.1.0/24')).toBe(true);
    const negated = B_POSTROUTING.replace('"op": "=="', '"op": "!="');
    expect(postroutingMasqueradesSubnet(negated, '10.0.1.0/24')).toBe(false);
  });

  it('reads an empty chain, and unparseable output, as not NATed', () => {
    expect(
      postroutingMasqueradesSubnet(
        filterRules(B_POSTROUTING, () => false),
        '10.0.1.0/24',
      ),
    ).toBe(false);
    expect(postroutingMasqueradesSubnet('not json', '10.0.1.0/24')).toBe(false);
  });
});

describe('baselineHoldsBridgeRules', () => {
  it('accepts the baseline a provisioned bridge carries for its own subnet', () => {
    // breaks-if-wrong: the provisioner's own output must verify.
    expect(baselineHoldsBridgeRules(B_BASELINE, cfgB)).toBe(true);
  });

  it('rejects a baseline that holds another subnet’s rules', () => {
    // fails-when: the flush-and-refill wrote the other bridge's subnet.
    expect(baselineHoldsBridgeRules(A_BASELINE_CLOBBERED, cfgA)).toBe(false);
  });

  it('rejects a baseline missing one of the subnet’s drops', () => {
    // 2241 is the 172.16.0.0/12 drop; without it the subnet reaches that range.
    expect(
      baselineHoldsBridgeRules(
        filterRules(B_BASELINE, (r) => r.handle !== 2241),
        cfgB,
      ),
    ).toBe(false);
  });

  it('rejects a baseline whose internet accept runs ahead of the drops', () => {
    // The accept is terminal, so ahead of the drops it lets every private range
    // through: the rules are all there, in an order that isolates nothing.
    const parsed = JSON.parse(B_BASELINE) as { nftables: Array<{ rule?: { handle: number } }> };
    const accept = parsed.nftables.find((e) => e.rule?.handle === 2244)!;
    const rest = parsed.nftables.filter((e) => e !== accept);
    const firstRule = rest.findIndex((e) => e.rule !== undefined);
    rest.splice(firstRule, 0, accept);
    expect(baselineHoldsBridgeRules(JSON.stringify({ nftables: rest }), cfgB)).toBe(false);
  });

  it('reads unparseable output as not holding the rules', () => {
    expect(baselineHoldsBridgeRules('', cfgB)).toBe(false);
  });
});

/** A runner answering every read verifyBridge makes, with the two chains supplied. */
function hostRunner(opts: {
  cfg: FirecrackerBridgeConfig;
  postrouting: string;
  baseline: string;
}): (spec: CommandSpec) => Promise<{ stdout: string }> {
  const { cfg } = opts;
  const [gw, prefix] = cfg.bridgeCidr.split('/');
  return async (spec) => {
    const line = [spec.bin, ...spec.args].join(' ');
    if (line === `ip -j link show ${cfg.bridgeName}`) return { stdout: '[{"operstate":"UP"}]' };
    if (line === `ip -j addr show ${cfg.bridgeName}`)
      return { stdout: `[{"addr_info":[{"local":"${gw}","prefixlen":${prefix}}]}]` };
    if (line === `nft list table ip ${cfg.table}`) return { stdout: `table ip ${cfg.table} {}` };
    if (line === `nft -j list chain ip ${cfg.table} forward`)
      return {
        stdout: '{"nftables":[{"rule":{"handle":1,"expr":[{"jump":{"target":"baseline"}}]}}]}',
      };
    if (line === `nft -j list chain ip ${cfg.table} postrouting`)
      return { stdout: opts.postrouting };
    if (line === `nft -j list chain ip ${cfg.table} baseline`) return { stdout: opts.baseline };
    if (line === `ip -d -j link show master ${cfg.bridgeName}`) return { stdout: '[]' };
    throw new Error(`unexpected command: ${line}`);
  };
}

describe('verifyBridge: NAT and baseline for the bridge subnet', () => {
  it('reads a provisioned bridge as healthy', async () => {
    const h = await verifyBridge(cfgB, {
      runner: hostRunner({ cfg: cfgB, postrouting: B_POSTROUTING, baseline: B_BASELINE }),
    });
    expect(h.detail).toBe('healthy');
    expect(h.healthy).toBe(true);
    expect(h.natPresent).toBe(true);
    expect(h.baselineRulesPresent).toBe(true);
  });

  it('reads a table another bridge was provisioned into as unhealthy, naming the lost NAT', async () => {
    // Bridge, address, table and tail jump are all in place: a check of the
    // chain layout alone reads this host as healthy and skips the self-heal,
    // while its VMs cannot resolve any host.
    const h = await verifyBridge(cfgA, {
      runner: hostRunner({
        cfg: cfgA,
        postrouting: A_POSTROUTING_CLOBBERED,
        baseline: A_BASELINE_CLOBBERED,
      }),
    });
    expect(h.healthy).toBe(false);
    expect(h.natPresent).toBe(false);
    expect(h.baselineRulesPresent).toBe(false);
    expect(h.detail).toContain('ip kici postrouting does not masquerade 10.0.0.0/24');
    expect(h.detail).toContain('ip kici baseline does not hold the 10.0.0.0/24 rules');
  });

  it('reads a chain it cannot list as unhealthy', async () => {
    const base = hostRunner({ cfg: cfgB, postrouting: B_POSTROUTING, baseline: B_BASELINE });
    const h = await verifyBridge(cfgB, {
      runner: async (spec) => {
        if (spec.args.join(' ') === '-j list chain ip kici_b postrouting') {
          throw new Error('Error: No such file or directory');
        }
        return base(spec);
      },
    });
    expect(h.healthy).toBe(false);
    expect(h.natPresent).toBe(false);
    expect(h.detail).toContain('could not read chain ip kici_b postrouting');
  });

  it('reports a malformed CIDR as a miss instead of throwing', async () => {
    // fails-when: the subnet derivation throws out of verifyBridge, which the
    // CLI surfaces as an unhandled rejection and diagnose as one error row.
    const cfg = { ...cfgB, bridgeCidr: '10.0.1.1' };
    const h = await verifyBridge(cfg, {
      runner: hostRunner({ cfg: cfgB, postrouting: B_POSTROUTING, baseline: B_BASELINE }),
    });
    expect(h.healthy).toBe(false);
    expect(h.natPresent).toBe(false);
    expect(h.baselineRulesPresent).toBe(false);
    expect(h.detail).toContain('invalid bridge CIDR 10.0.1.1');
  });
});
