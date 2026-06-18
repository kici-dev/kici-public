import { describe, it, expect } from 'vitest';
import { buildIsolationRuleOps, parseRuleHandles } from './nftables.js';

describe('parseRuleHandles', () => {
  const sampleOutput = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "veth-abc123" ip daddr 10.0.0.1 accept # handle 5
    iifname "veth-abc123" ip daddr 10.0.0.0/8 drop # handle 6
    iifname "veth-abc123" ip daddr 172.16.0.0/12 drop # handle 7
    iifname "veth-abc123" ip daddr 192.168.0.0/16 drop # handle 8
    iifname "veth-abc123" ip daddr 169.254.0.0/16 drop # handle 9
    iifname "veth-xyz789" ip daddr 10.0.0.1 accept # handle 10
    iifname "veth-xyz789" ip daddr 10.0.0.0/8 drop # handle 11
  }
}`;

  it('extracts handles for a specific interface', () => {
    const handles = parseRuleHandles(sampleOutput, 'veth-abc123');
    expect(handles).toEqual([5, 6, 7, 8, 9]);
  });

  it('extracts handles for a different interface', () => {
    const handles = parseRuleHandles(sampleOutput, 'veth-xyz789');
    expect(handles).toEqual([10, 11]);
  });

  it('returns empty array for unknown interface', () => {
    const handles = parseRuleHandles(sampleOutput, 'veth-unknown');
    expect(handles).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    const handles = parseRuleHandles('', 'veth-abc123');
    expect(handles).toEqual([]);
  });

  it('handles output with UID-based rules', () => {
    const uidOutput = `table ip kici {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid 10001 ip daddr 10.0.0.0/8 drop # handle 3
    meta skuid 10001 ip daddr 172.16.0.0/12 drop # handle 4
    meta skuid 10002 ip daddr 10.0.0.0/8 drop # handle 5
  }
}`;

    const handles = parseRuleHandles(uidOutput, '10001');
    expect(handles).toEqual([3, 4]);
  });

  it('ignores lines without handle comments', () => {
    const partialOutput = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "veth-abc123" ip daddr 10.0.0.1 accept # handle 5
    some random line with veth-abc123
  }
}`;

    const handles = parseRuleHandles(partialOutput, 'veth-abc123');
    expect(handles).toEqual([5]);
  });

  it('extracts handles for saddr-based rules (container IP matching)', () => {
    const saddrOutput = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    ip saddr 172.30.0.5 ip daddr 172.30.0.1 accept # handle 20
    ip saddr 172.30.0.5 ip daddr 10.0.0.0/8 drop # handle 21
    ip saddr 172.30.0.5 ip daddr 172.16.0.0/12 drop # handle 22
    ip saddr 172.30.0.5 ip daddr 192.168.0.0/16 drop # handle 23
    ip saddr 172.30.0.5 ip daddr 169.254.0.0/16 drop # handle 24
    ip saddr 172.30.0.6 ip daddr 172.30.0.1 accept # handle 25
    ip saddr 172.30.0.6 ip daddr 10.0.0.0/8 drop # handle 26
  }
}`;

    const handles = parseRuleHandles(saddrOutput, '172.30.0.5');
    expect(handles).toEqual([20, 21, 22, 23, 24]);
  });

  it('does not false-match container IPs against RFC1918 CIDRs', () => {
    const mixedOutput = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    ip saddr 172.30.0.5 ip daddr 172.16.0.0/12 drop # handle 30
    iifname "br-abc123" ip daddr 172.16.0.0/12 drop # handle 31
  }
}`;

    // 172.30.0.5 should not match the bridge rule even though 172 is common
    const handles = parseRuleHandles(mixedOutput, '172.30.0.5');
    expect(handles).toEqual([30]);
  });
});

describe('buildIsolationRuleOps', () => {
  const matchClause = ['iifname', 'kici-abc123'];

  it('inserts gateway and allowlist accepts at the chain head', () => {
    // The kici forward chain is shared and may carry host-baseline wildcard
    // drops (e.g. iifname "kici-*" 10.0.0.0/8 drop). nftables is
    // first-match-wins, so an accept appended after such a drop never fires
    // — every accept must go in via insert.
    const ops = buildIsolationRuleOps(matchClause, '10.0.0.1', {
      allowlist: ['10.67.0.1/32', '100.64.0.7/32'],
    });
    const accepts = ops.filter((op) => op.tokens.at(-1) === 'accept');
    expect(accepts).toHaveLength(3); // gateway + 2 allowlist entries
    for (const op of accepts) {
      expect(op.verb).toBe('insert');
    }
    expect(accepts.map((op) => op.tokens.at(-2))).toEqual([
      '10.0.0.1',
      '10.67.0.1/32',
      '100.64.0.7/32',
    ]);
  });

  it('appends RFC1918 and metadata drops at the tail', () => {
    const ops = buildIsolationRuleOps(matchClause, '10.0.0.1');
    const drops = ops.filter((op) => op.tokens.at(-1) === 'drop');
    expect(drops.map((op) => op.tokens.at(-2))).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
    ]);
    for (const op of drops) {
      expect(op.verb).toBe('add');
    }
  });

  it('appends a bare drop when denyAll is set', () => {
    const ops = buildIsolationRuleOps(matchClause, '10.0.0.1', { denyAll: true });
    const last = ops.at(-1)!;
    expect(last.verb).toBe('add');
    expect(last.tokens).toEqual(['iifname', 'kici-abc123', 'drop']);
  });

  it('scopes every rule to the match clause', () => {
    const ops = buildIsolationRuleOps(['ip', 'saddr', '172.30.0.5'], '172.30.0.1', {
      allowlist: ['10.67.0.1/32'],
    });
    for (const op of ops) {
      expect(op.tokens.slice(0, 3)).toEqual(['ip', 'saddr', '172.30.0.5']);
    }
  });
});

describe('parseRuleHandles identifier boundaries', () => {
  it('does not let an IP identifier claim rules for a longer IP sharing its prefix', () => {
    const output = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    ip saddr 10.0.0.2 ip daddr 10.0.0.1 accept # handle 40
    ip saddr 10.0.0.20 ip daddr 10.0.0.1 accept # handle 41
    ip saddr 10.0.0.2 ip daddr 10.0.0.0/8 drop # handle 42
    ip saddr 10.0.0.20 ip daddr 10.0.0.0/8 drop # handle 43
  }
}`;
    expect(parseRuleHandles(output, '10.0.0.2')).toEqual([40, 42]);
    expect(parseRuleHandles(output, '10.0.0.20')).toEqual([41, 43]);
  });

  it('does not let an interface identifier claim rules for a longer name sharing its prefix', () => {
    const output = `table ip kici {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "kici-ab" ip daddr 10.0.0.0/8 drop # handle 50
    iifname "kici-abcd" ip daddr 10.0.0.0/8 drop # handle 51
  }
}`;
    expect(parseRuleHandles(output, 'kici-ab')).toEqual([50]);
    expect(parseRuleHandles(output, 'kici-abcd')).toEqual([51]);
  });
});
