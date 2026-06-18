import { describe, it, expect } from 'vitest';
import {
  cidrToNetwork,
  buildBridgeCommands,
  NM_CONF_PATH,
  NM_CONF_CONTENT,
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
    // the bridge subnet; the inbound rule is daddr-scoped to it instead.
    for (const c of ruleCmds) {
      const line = c.args.join(' ');
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
    expect(NM_CONF_CONTENT).toContain('unmanaged-devices=interface-name:kici-*');
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

  it('tolerates a missing-table delete on first provision', async () => {
    const calls: string[] = [];
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      calls.push(line);
      if (line === 'nft delete table ip kici') throw new Error('No such file or directory');
      return { stdout: '' };
    };
    await expect(
      provisionBridge(cfgA, { runner, writeNmConf: noopWriteNmConf }),
    ).resolves.toBeUndefined();
    expect(calls).toContain('nft add table ip kici');
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

describe('verifyBridge', () => {
  it('reports healthy when bridge up + addr + table present', async () => {
    const runner = async (spec: CommandSpec) => {
      const line = [spec.bin, ...spec.args].join(' ');
      if (line.startsWith('ip -j link show kici-br0')) return { stdout: '[{"operstate":"UP"}]' };
      if (line.startsWith('ip -j addr show kici-br0'))
        return { stdout: '[{"addr_info":[{"local":"10.0.0.1","prefixlen":24}]}]' };
      if (line === 'nft list table ip kici') return { stdout: 'table ip kici {}' };
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
      return { stdout: '' };
    };
    const h = await verifyBridge(cfgA, { runner });
    expect(h.healthy).toBe(true);
    expect(h.bridgeUp).toBe(true);
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
    expect(script).toContain('[keyfile]\nunmanaged-devices=interface-name:kici-*');
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
