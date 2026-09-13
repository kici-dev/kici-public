import { describe, it, expect } from 'vitest';
import {
  cidrToNetwork,
  buildBridgeCommands,
  NM_CONF_PATH,
  NM_CONF_CONTENT,
  FIRECRACKER_NET_INTERFACES,
  provisionBridge,
  verifyBridge,
  teardownBridge,
  renderBootScript,
  type CommandSpec,
} from './host-network.js';

describe('cidrToNetwork', () => {
  it('derives the /24 network from a gateway CIDR', () => {
    expect(cidrToNetwork('10.0.0.1/24')).toBe('10.0.0.0/24');
    expect(cidrToNetwork('10.0.1.1/24')).toBe('10.0.1.0/24');
  });

  it('masks host bits for non-/24 prefixes', () => {
    expect(cidrToNetwork('10.0.0.130/25')).toBe('10.0.0.128/25');
    expect(cidrToNetwork('172.16.5.9/16')).toBe('172.16.0.0/16');
    expect(cidrToNetwork('192.168.1.1/30')).toBe('192.168.1.0/30');
  });

  it('throws on a malformed CIDR', () => {
    expect(() => cidrToNetwork('10.0.0.1')).toThrow(/CIDR/);
    expect(() => cidrToNetwork('10.0.0.1/33')).toThrow(/prefix/);
    expect(() => cidrToNetwork('999.0.0.1/24')).toThrow(/octet/);
  });
});

const cfgA = {
  bridgeName: 'kici-br0',
  bridgeCidr: '10.0.0.1/24',
  table: 'kici',
  hostIface: 'eth0',
};

describe('buildBridgeCommands', () => {
  it('creates the bridge, assigns the CIDR, brings it up', () => {
    const cmds = buildBridgeCommands(cfgA);
    const flat = cmds.map((c) => [c.bin, ...c.args].join(' '));
    expect(flat).toContain('ip link add name kici-br0 type bridge');
    expect(flat).toContain('ip addr add 10.0.0.1/24 dev kici-br0');
    expect(flat).toContain('ip link set kici-br0 up');
  });

  it('enables IPv4 forwarding', () => {
    const flat = buildBridgeCommands(cfgA).map((c) => [c.bin, ...c.args].join(' '));
    expect(flat).toContain('sysctl -w net.ipv4.ip_forward=1');
  });

  it('requires a resolved hostIface', () => {
    expect(() => buildBridgeCommands({ ...cfgA, hostIface: undefined })).toThrow(/hostIface/);
  });

  it('uses the configured nft table name and never references another table', () => {
    const cmds = buildBridgeCommands({
      ...cfgA,
      table: 'kici_b',
      bridgeName: 'kici-br1',
      bridgeCidr: '10.0.1.1/24',
    });
    const nftCmds = cmds.filter((c) => c.bin === 'nft');
    // Every nft command targets table kici_b.
    for (const c of nftCmds) {
      expect(c.args).toContain('kici_b');
      expect(c.args).not.toContain('kici');
    }
  });

  it('source-scopes every forward/postrouting/mss rule to the bridge subnet', () => {
    const cmds = buildBridgeCommands(cfgA);
    const ruleCmds = cmds.filter(
      (c) => c.bin === 'nft' && c.args[0] === 'add' && c.args[1] === 'rule',
    );
    expect(ruleCmds.length).toBeGreaterThan(0);
    // Every rule except the inbound established/related rule is saddr-scoped to
    // the bridge subnet; the inbound rule is daddr-scoped to it instead. The
    // tail `jump baseline` carries no address by construction — it is the hop
    // into the chain whose rules are the ones being scoped.
    for (const c of ruleCmds) {
      const line = c.args.join(' ');
      if (line.endsWith('jump baseline')) continue;
      expect(line).toMatch(/(ip saddr 10\.0\.0\.0\/24|ip daddr 10\.0\.0\.0\/24)/);
    }
  });

  it('emits RFC1918 + metadata drops and a gateway accept', () => {
    const flat = buildBridgeCommands(cfgA).map((c) => c.args.join(' '));
    expect(flat.some((l) => l.includes('ip daddr 10.0.0.1 accept'))).toBe(true); // gateway
    expect(flat.some((l) => l.includes('ip daddr 10.0.0.0/8 drop'))).toBe(true);
    expect(flat.some((l) => l.includes('ip daddr 172.16.0.0/12 drop'))).toBe(true);
    expect(flat.some((l) => l.includes('ip daddr 192.168.0.0/16 drop'))).toBe(true);
    expect(flat.some((l) => l.includes('ip daddr 169.254.0.0/16 drop'))).toBe(true);
  });

  it('accepts the FC subnet in DOCKER-USER (docker coexistence), idempotently', () => {
    const flat = buildBridgeCommands(cfgA).map((c) => [c.bin, ...c.args].join(' '));
    // Delete-then-insert, both directions, so a re-run does not stack duplicates.
    expect(flat).toContain('iptables -D DOCKER-USER -s 10.0.0.0/24 -j ACCEPT');
    expect(flat).toContain('iptables -I DOCKER-USER -s 10.0.0.0/24 -j ACCEPT');
    expect(flat).toContain('iptables -D DOCKER-USER -d 10.0.0.0/24 -j ACCEPT');
    expect(flat).toContain('iptables -I DOCKER-USER -d 10.0.0.0/24 -j ACCEPT');
  });

  it('masquerades outbound on the host interface, source-scoped', () => {
    const flat = buildBridgeCommands(cfgA).map((c) => c.args.join(' '));
    expect(
      flat.some((l) => l.includes('ip saddr 10.0.0.0/24') && l.includes('oifname eth0 masquerade')),
    ).toBe(true);
  });

  it('recreates the table idempotently (delete-if-exists then add)', () => {
    const cmds = buildBridgeCommands(cfgA);
    const idxDelete = cmds.findIndex((c) => c.args.join(' ') === 'delete table ip kici');
    const idxAdd = cmds.findIndex((c) => c.args.join(' ') === 'add table ip kici');
    expect(idxAdd).toBeGreaterThan(idxDelete);
  });
});

describe('NetworkManager unmanaged conf', () => {
  it('targets the host-scoped kici-* interface pattern', () => {
    expect(NM_CONF_PATH).toBe('/etc/NetworkManager/conf.d/90-kici-unmanaged.conf');
    // The += append operator is mandatory so this drop-in doesn't collide with
    // other conf.d unmanaged-devices lines under NM's last-wins merge. See
    // .claude/rules/networkmanager-unmanaged.md.
    expect(NM_CONF_CONTENT).toContain('unmanaged-devices+=interface-name:kici-*');
  });

  it('renders every FIRECRACKER_NET_INTERFACES pattern with the += operator', () => {
    // The watchdog derives its expected-pattern set from this constant, so every
    // pattern it advertises must actually reach the rendered drop-in. Assert the
    // constant is non-empty first: an empty list would make the loop below
    // vacuously green while the drop-in silently rendered no unmanaged rule.
    expect(FIRECRACKER_NET_INTERFACES.length).toBeGreaterThan(0);
    for (const pattern of FIRECRACKER_NET_INTERFACES) {
      expect(NM_CONF_CONTENT).toContain(`unmanaged-devices+=interface-name:${pattern}`);
    }
  });
});

const noopWriteNmConf = async () => {};

describe('provisionBridge', () => {
  it('rethrows when a provisioning command fails (no swallow)', async () => {
    const runner = async (spec: CommandSpec) => {
      if (spec.bin === 'ip' && spec.args.includes('add')) {
        throw new Error('RTNETLINK answers: Operation not permitted');
      }
      return { stdout: '' };
    };
    await expect(provisionBridge(cfgA, { runner, writeNmConf: noopWriteNmConf })).rejects.toThrow(
      /Operation not permitted/,
    );
  });

  it('never deletes the table, so a self-heal cannot strip a live VM of its rules', async () => {
    // `ensureHostReady` re-provisions on any of four conditions, none of which
    // knows how many VMs are running. Deleting the table left every one of
    // them fail-open — full RFC1918 and cloud-metadata reach — until it was
    // destroyed, and logged nothing.
    const calls: string[] = [];
    const runner = async (spec: CommandSpec) => {
      calls.push([spec.bin, ...spec.args].join(' '));
      return { stdout: '' };
    };
    await expect(
      provisionBridge(cfgA, { runner, writeNmConf: noopWriteNmConf }),
    ).resolves.toBeUndefined();
    expect(calls).toContain('nft add table ip kici');
    expect(calls.some((c) => c.startsWith('nft delete table'))).toBe(false);
    // The baseline is what gets rebuilt instead, in its own regular chain.
    expect(calls).toContain('nft add chain kici baseline');
    expect(calls).toContain('nft flush chain kici baseline');
    expect(calls).toContain('nft add rule kici forward jump baseline');
  });

  it('is idempotent on a re-run: tolerates an existing bridge + already-assigned addr', async () => {
    // Second provision against an already-set-up host: `ip link add` answers
    // "File exists", `ip addr add` answers "Address already assigned." Both
    // must be treated as benign no-ops so the deploy stays green on re-run.
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip link add')) throw new Error('RTNETLINK answers: File exists');
      if (line.startsWith('ip addr add')) throw new Error('Error: ipv4: Address already assigned.');
      return { stdout: '' };
    };
    await expect(
      provisionBridge(cfgA, { runner, writeNmConf: noopWriteNmConf }),
    ).resolves.toBeUndefined();
  });
});

/** A forward chain whose last rule is the jump into the baseline chain. */
const HEALTHY_FORWARD_JSON =
  '{"nftables":[{"rule":{"handle":1,"expr":[{"jump":{"target":"baseline"}}]}}]}';

describe('verifyBridge', () => {
  it('reports healthy when bridge up + addr + table present', async () => {
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip -j link show kici-br0')) return { stdout: '[{"operstate":"UP"}]' };
      if (line.startsWith('ip -j addr show kici-br0'))
        return { stdout: '[{"addr_info":[{"local":"10.0.0.1","prefixlen":24}]}]' };
      if (line === 'nft list table ip kici') return { stdout: 'table ip kici {}' };
      if (line === 'nft -j list chain ip kici forward') return { stdout: HEALTHY_FORWARD_JSON };
      if (line.startsWith('ip -d -j link show master')) return { stdout: '[]' };
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(true);
  });

  it('reports healthy for an admin-up bridge with no carrier (no TAP enslaved yet)', async () => {
    // Freshly-provisioned bridge with no microVM: IFF_UP is set but operstate
    // is DOWN + NO-CARRIER. This is the normal post-provision state and must
    // verify as healthy, or the deploy verify step fails a working host.
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip -j link show kici-br0'))
        return { stdout: '[{"operstate":"DOWN","flags":["NO-CARRIER","BROADCAST","UP"]}]' };
      if (line.startsWith('ip -j addr show kici-br0'))
        return { stdout: '[{"addr_info":[{"local":"10.0.0.1","prefixlen":24}]}]' };
      if (line === 'nft list table ip kici') return { stdout: 'table ip kici {}' };
      if (line === 'nft -j list chain ip kici forward') return { stdout: HEALTHY_FORWARD_JSON };
      if (line.startsWith('ip -d -j link show master')) return { stdout: '[]' };
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(true);
    expect(h.bridgeUp).toBe(true);
  });

  it('reports unhealthy when the forward chain does not end in the baseline jump', async () => {
    // A half-provisioned host: per-VM rules but no host baseline behind them,
    // so nothing NATs or drops for the subnet. It must not read as healthy, or
    // `ensureHostReady` skips the self-heal that would fix it.
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip -j link show kici-br0')) return { stdout: '[{"operstate":"UP"}]' };
      if (line.startsWith('ip -j addr show kici-br0'))
        return { stdout: '[{"addr_info":[{"local":"10.0.0.1","prefixlen":24}]}]' };
      if (line === 'nft list table ip kici') return { stdout: 'table ip kici {}' };
      if (line === 'nft -j list chain ip kici forward')
        return {
          stdout:
            '{"nftables":[{"rule":{"handle":1,"expr":[{"match":{"op":"==","left":{"payload":{"field":"saddr"}},"right":"10.0.0.5"}}]}}]}',
        };
      if (line.startsWith('ip -d -j link show master')) return { stdout: '[]' };
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(false);
    expect(h.baselineChainPresent).toBe(false);
    expect(h.detail).toMatch(/jump baseline/);
  });

  it('reports unhealthy when an enslaved TAP is missing port isolation', async () => {
    // Without `isolated on` every concurrent tenant's VM reaches every other
    // one at L2, where no nftables rule can see the traffic.
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip -j link show kici-br0')) return { stdout: '[{"operstate":"UP"}]' };
      if (line.startsWith('ip -j addr show kici-br0'))
        return { stdout: '[{"addr_info":[{"local":"10.0.0.1","prefixlen":24}]}]' };
      if (line === 'nft list table ip kici') return { stdout: 'table ip kici {}' };
      if (line === 'nft -j list chain ip kici forward') return { stdout: HEALTHY_FORWARD_JSON };
      if (line.startsWith('ip -d -j link show master')) {
        return {
          stdout: JSON.stringify([
            { ifname: 'kici-a1b2c3d4', linkinfo: { info_slave_data: { isolated: true } } },
            { ifname: 'kici-deadbeef', linkinfo: { info_slave_data: { isolated: false } } },
          ]),
        };
      }
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(false);
    expect(h.tapIsolationPresent).toBe(false);
    expect(h.detail).toMatch(/kici-deadbeef/);
    // The isolated one is not named as a miss.
    expect(h.detail).not.toMatch(/kici-a1b2c3d4/);
  });

  it('reports unhealthy with detail when the bridge is missing', async () => {
    const runner = async (spec: CommandSpec) => {
      if (spec.args.includes('link')) throw new Error('Device "kici-br0" does not exist');
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(false);
    expect(h.bridgeExists).toBe(false);
    expect(h.detail).toMatch(/kici-br0/);
  });
});

describe('teardownBridge', () => {
  it('removes the bridge + nft table but never touches the host-scoped NM conf', async () => {
    const calls: string[] = [];
    const runner = async (spec: CommandSpec) => {
      calls.push([spec.bin, ...spec.args].join(' '));
      return { stdout: '' };
    };
    await teardownBridge(cfgA, { runner });
    expect(calls).toContain('nft delete table ip kici');
    expect(calls).toContain('ip link del kici-br0');
    // The host-scoped NM conf (interface-name:kici-* — matches every bridge +
    // TAP) must survive a per-bridge teardown, or NetworkManager adopts the
    // OTHER bridges and strips their gateway IPs. Pin that invariant.
    expect(calls.join('\n')).not.toContain(NM_CONF_PATH);
    expect(calls.join('\n')).not.toContain('90-kici-unmanaged');
  });
});

describe('renderBootScript', () => {
  it('renders a self-contained, set -euo pipefail script that auto-detects iface', () => {
    const script = renderBootScript({
      bridgeName: 'kici-br0',
      bridgeCidr: '10.0.0.1/24',
      table: 'kici',
    });
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    // Iface re-detected at boot, not baked.
    expect(script).toContain('HOST_IFACE=$(ip -j route show default');
    expect(script).toContain('ip link add name kici-br0 type bridge');
    expect(script).toContain('nft add table ip kici');
    // Source-scoping survives into the rendered script.
    expect(script).toContain('ip saddr 10.0.0.0/24');
  });

  it('quotes the host-iface variable in nft rule args', () => {
    const script = renderBootScript({
      bridgeName: 'kici-br1',
      bridgeCidr: '10.0.1.1/24',
      table: 'kici_b',
    });
    expect(script).toContain('"$HOST_IFACE"');
  });

  it('writes the NM-unmanaged conf with real newlines, not collapsed onto one line', () => {
    const script = renderBootScript({
      bridgeName: 'kici-br0',
      bridgeCidr: '10.0.0.1/24',
      table: 'kici',
    });
    // The conf must reach the host with its keyfile section + directive on
    // their own lines. A `printf '%s'` with \n-escaped content collapses it
    // onto a single comment line that NetworkManager ignores, leaving kici-*
    // interfaces NM-managed on reboot. Assert the real-newline structure and
    // that no literal backslash-n leaks into the conf body.
    expect(script).toContain('[keyfile]\nunmanaged-devices+=interface-name:kici-*');
    expect(script).not.toContain('[keyfile]\\nunmanaged-devices');
    // The whole NM_CONF_CONTENT lands verbatim somewhere in the script.
    expect(script).toContain(NM_CONF_CONTENT.replace(/\n$/, ''));
  });

  it('single-quotes the kici-* iifname so bash does not glob-expand it', () => {
    const script = renderBootScript({
      bridgeName: 'kici-br0',
      bridgeCidr: '10.0.0.1/24',
      table: 'kici',
    });
    // The nft iifname match must reach nft literally, not be expanded by the
    // shell against the CWD. Assert the token is single-quoted, never bare.
    expect(script).toContain("iifname 'kici-*'");
    expect(script).not.toMatch(/iifname kici-\*/);
  });
});
