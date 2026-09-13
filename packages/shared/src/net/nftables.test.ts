import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const {
  buildIsolationRuleOps,
  parseRuleHandles,
  listForwardRules,
  listIsolationRules,
  addIsolationRules,
  parseHostAccess,
  buildHostAccessRuleOps,
  addHostIsolationRules,
  removeHostIsolationRules,
  readForwardChain,
  removeIsolationRules,
} = await import('./nftables.js');

/** Make every `nft` invocation answer with `stdout`. */
function nftReturns(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout, stderr: '' }),
  );
}

/** Make every `nft` invocation fail. */
function nftFails(message: string): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) =>
      cb(new Error(message)),
  );
}

beforeEach(() => {
  mockExecFile.mockReset();
});

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

  it('puts gateway and allowlist accepts ahead of every drop', () => {
    // nftables is first-match-wins and `accept` is terminal, so an allowlisted
    // destination inside a dropped range (a 10.x registry endpoint behind the
    // 10.0.0.0/8 drop) is only reachable if its accept precedes the drop.
    const rules = buildIsolationRuleOps(matchClause, '10.0.0.1', {
      allowlist: ['10.67.0.1/32', '100.64.0.7/32'],
    });
    const firstDrop = rules.findIndex((r) => r.at(-1) === 'drop');
    const accepts = rules.filter((r) => r.at(-1) === 'accept');

    expect(accepts).toHaveLength(3); // gateway + 2 allowlist entries
    expect(accepts.map((r) => r.at(-2))).toEqual(['10.0.0.1', '10.67.0.1/32', '100.64.0.7/32']);
    for (const accept of accepts) {
      expect(rules.indexOf(accept)).toBeLessThan(firstDrop);
    }
  });

  it('orders the RFC1918 and metadata drops after the accepts', () => {
    const rules = buildIsolationRuleOps(matchClause, '10.0.0.1');
    const drops = rules.filter((r) => r.at(-1) === 'drop');
    expect(drops.map((r) => r.at(-2))).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
    ]);
    expect(rules[0].at(-1)).toBe('accept');
  });

  it('puts the denyAll drop last, so it is still ahead of the baseline jump', () => {
    // The baseline chain carries an unconditional internet accept. `denyAll`
    // only denies if it is evaluated first — which it is, because the whole
    // per-VM block is inserted at the head and the jump is the tail rule.
    const rules = buildIsolationRuleOps(matchClause, '10.0.0.1', { denyAll: true });
    expect(rules.at(-1)).toEqual(['iifname', 'kici-abc123', 'drop']);
  });

  it('scopes every rule to the match clause', () => {
    const rules = buildIsolationRuleOps(['ip', 'saddr', '172.30.0.5'], '172.30.0.1', {
      allowlist: ['10.67.0.1/32'],
    });
    for (const tokens of rules) {
      expect(tokens.slice(0, 3)).toEqual(['ip', 'saddr', '172.30.0.5']);
    }
  });
});

describe('addIsolationRules placement', () => {
  /** The `nft` argv of every call, in the order they were issued. */
  function issued(): string[][] {
    return mockExecFile.mock.calls.map((c) => c[1] as string[]);
  }

  it('inserts every rule, so the block lands ahead of the tail baseline jump', async () => {
    // The host baseline lives in its own chain reached by a jump appended as
    // the forward chain's LAST rule. An appended per-VM rule would land after
    // that jump and never be reached — which is how `denyAll` used to grant
    // full egress: the baseline's unconditional internet accept terminated the
    // chain first.
    nftReturns('');
    await addIsolationRules('10.0.0.5', '10.0.0.1', { denyAll: true }, 'saddr');

    const argvs = issued();
    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) {
      expect(argv[0]).toBe('insert');
      expect(argv.slice(1, 5)).toEqual(['rule', 'ip', 'kici', 'forward']);
    }
  });

  it('issues the inserts in reverse, so the chain reads gateway → allowlist → drops', async () => {
    // Each `insert` prepends, so the LAST issued command ends up first in the
    // chain. Reversing the build order is what makes the landed order match
    // `buildIsolationRuleOps`.
    nftReturns('');
    await addIsolationRules(
      '10.0.0.5',
      '10.0.0.1',
      { allowlist: ['10.67.0.0/16'], denyAll: true },
      'saddr',
    );

    // Undo the insert semantics to recover the order the chain ends up in.
    const landed = issued()
      .map((argv) => argv.slice(5))
      .reverse();
    expect(landed).toEqual(
      buildIsolationRuleOps(['ip', 'saddr', '10.0.0.5'], '10.0.0.1', {
        allowlist: ['10.67.0.0/16'],
        denyAll: true,
      }),
    );
    // The allowlisted 10.x destination is reachable only because its accept
    // precedes the 10.0.0.0/8 drop.
    const acceptAt = landed.findIndex((r) => r.includes('10.67.0.0/16'));
    const dropAt = landed.findIndex((r) => r.includes('10.0.0.0/8'));
    expect(acceptAt).toBeLessThan(dropAt);
    // And the denyAll drop is last, still ahead of the jump.
    expect(landed.at(-1)).toEqual(['ip', 'saddr', '10.0.0.5', 'drop']);
  });

  it('writes to the configured table', async () => {
    nftReturns('');
    await addIsolationRules('10.0.0.5', '10.0.0.1', undefined, 'saddr', { table: 'kici_b' });
    for (const argv of issued()) {
      expect(argv).toContain('kici_b');
      expect(argv).not.toContain('kici');
    }
  });
});

describe('listForwardRules identifier extraction', () => {
  const json = JSON.stringify({
    nftables: [
      { metainfo: { version: '1.0.9' } },
      // A per-VM rule: a single host address.
      {
        rule: {
          handle: 10,
          expr: [{ match: { op: '==', left: { payload: { field: 'saddr' } }, right: '10.0.0.5' } }],
        },
      },
      // A host baseline rule: a whole subnet, which nft renders as a prefix object.
      {
        rule: {
          handle: 11,
          expr: [
            {
              match: {
                op: '==',
                left: { payload: { field: 'saddr' } },
                right: { prefix: { addr: '10.0.0.0', len: 24 } },
              },
            },
          ],
        },
      },
      // A host baseline rule matching the kici-* wildcard.
      {
        rule: {
          handle: 12,
          expr: [{ match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'kici-*' } }],
        },
      },
      // A per-VM rule keyed on one exact TAP name.
      {
        rule: {
          handle: 13,
          expr: [
            { match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'kici-a1b2c3d4' } },
          ],
        },
      },
      // The tail jump into the baseline chain.
      { rule: { handle: 14, expr: [{ jump: { target: 'baseline' } }] } },
      // The host's inbound established/related rule. It LEADS with a concrete
      // interface — the egress NIC — and names the kici-* wildcard only later,
      // in oifname. Answering on the first concrete interface claimed it for a
      // nonexistent agent named after the NIC.
      {
        rule: {
          handle: 15,
          expr: [
            { match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'enp1s0f0' } },
            {
              match: {
                op: '==',
                left: { payload: { field: 'daddr' } },
                right: { prefix: { addr: '10.0.0.0', len: 24 } },
              },
            },
            { match: { op: '==', left: { meta: { key: 'oifname' } }, right: 'kici-*' } },
          ],
        },
      },
    ],
  });

  it('separates per-agent rules from host-owned ones', async () => {
    nftReturns(json);
    const rules = await listForwardRules();
    expect(rules.map((r) => [r.handle, r.identifier])).toEqual([
      [10, '10.0.0.5'],
      [11, null], // a subnet is the host baseline, not an agent
      [12, null], // so is the kici-* wildcard
      [13, 'kici-a1b2c3d4'],
      [14, null], // the jump owns no agent
      [15, null], // a wildcard LATER in the rule still makes it the host's
    ]);
  });

  it('groups handles by identifier', async () => {
    nftReturns(json);
    const byId = await listIsolationRules();
    expect([...byId.entries()]).toEqual([
      ['10.0.0.5', [10]],
      ['kici-a1b2c3d4', [13]],
    ]);
  });

  it('returns nothing rather than throwing when the chain cannot be read', async () => {
    // A failed read must not be mistaken for "no rules are there" — a caller
    // that did would sweep a chain it never managed to look at.
    nftFails('No such file or directory');
    await expect(listForwardRules()).resolves.toEqual([]);
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

describe('parseHostAccess grammar', () => {
  it('reads a bare number as a port on any host address', () => {
    expect(parseHostAccess('5000')).toEqual({ daddr: null, port: 5000 });
  });

  it('reads a cidr with a port', () => {
    expect(parseHostAccess('10.98.0.0/24:443')).toEqual({ daddr: '10.98.0.0/24', port: 443 });
  });

  it('reads the explicit any-address form', () => {
    expect(parseHostAccess('*:10143')).toEqual({ daddr: null, port: 10143 });
  });

  it('reads a bare address as every port on that address', () => {
    expect(parseHostAccess('192.168.1.85')).toEqual({ daddr: '192.168.1.85', port: null });
  });

  it('reads an explicit port wildcard the same way', () => {
    expect(parseHostAccess('10.0.0.0/8:*')).toEqual({ daddr: '10.0.0.0/8', port: null });
  });

  it('rejects a hostname', () => {
    // nftables matches addresses. A name resolved when the rule is built goes
    // stale the next time it moves, with no error anywhere.
    expect(() => parseHostAccess('registry.internal:5000')).toThrow(/not an IPv4 address/);
  });

  it('rejects a port outside 1-65535', () => {
    expect(() => parseHostAccess('*:0')).toThrow(/outside 1-65535/);
    expect(() => parseHostAccess('*:70000')).toThrow(/outside 1-65535/);
  });

  it('rejects a negative port', () => {
    expect(() => parseHostAccess('*:-1')).toThrow(/non-numeric port/);
  });

  it('rejects a malformed CIDR', () => {
    expect(() => parseHostAccess('10.0.0.0/33:443')).toThrow(/not an IPv4 address/);
    expect(() => parseHostAccess('999.0.0.1:443')).toThrow(/not an IPv4 address/);
  });

  it('rejects an empty entry', () => {
    expect(() => parseHostAccess('   ')).toThrow(/is empty/);
  });
});

describe('buildHostAccessRuleOps', () => {
  const match = ['ip', 'saddr', '172.31.0.0/16'];
  const CT = [...match, 'ct', 'state', 'established,related', 'accept'];

  it('leads with the conntrack exception so a host-initiated flow is not severed', () => {
    // The chain is keyed on the sandbox as the SOURCE, so it also sees the
    // reply leg of a connection the HOST opened. Measured on this host: with
    // the terminal drop and no ct rule, a curl from the host into a container
    // on the range timed out; adding this rule restored it while a sandbox
    // connecting OUT to an unlisted host port stayed refused.
    expect(buildHostAccessRuleOps(match, [])[0]).toEqual(CT);
  });

  it('emits an accept per protocol for a port entry, then the terminal drop', () => {
    // UDP is load-bearing, not symmetry: a container whose resolver is the
    // bridge gateway resolves over UDP, so a tcp-only accept on 53 leaves it
    // unable to resolve any name.
    expect(buildHostAccessRuleOps(match, ['172.31.0.1:53'])).toEqual([
      CT,
      [...match, 'ip', 'daddr', '172.31.0.1', 'tcp', 'dport', '53', 'accept'],
      [...match, 'ip', 'daddr', '172.31.0.1', 'udp', 'dport', '53', 'accept'],
      [...match, 'drop'],
    ]);
  });

  it('omits the daddr clause for the any-address form, so it matches every host address', () => {
    expect(buildHostAccessRuleOps(match, ['*:10143'])).toEqual([
      CT,
      [...match, 'tcp', 'dport', '10143', 'accept'],
      [...match, 'udp', 'dport', '10143', 'accept'],
      [...match, 'drop'],
    ]);
  });

  it('emits a single unported accept for an address with no port', () => {
    expect(buildHostAccessRuleOps(match, ['192.168.1.85'])).toEqual([
      CT,
      [...match, 'ip', 'daddr', '192.168.1.85', 'accept'],
      [...match, 'drop'],
    ]);
  });

  it('denies everything host-destined when the policy is empty', () => {
    expect(buildHostAccessRuleOps(match, [])).toEqual([CT, [...match, 'drop']]);
  });

  it('keeps every accept ahead of the drop', () => {
    const rules = buildHostAccessRuleOps(match, ['53', '10143', '10.98.0.0/24:443']);
    expect(rules.at(-1)).toEqual([...match, 'drop']);
    expect(rules.slice(0, -1).every((r) => r.at(-1) === 'accept')).toBe(true);
    expect(rules[0]).toEqual(CT);
  });
});

describe('addHostIsolationRules placement', () => {
  function issued(): string[][] {
    return mockExecFile.mock.calls.map((c) => c[1] as string[]);
  }

  it('lands the accepts above the terminal drop', async () => {
    // Each `insert` prepends, so the build order is applied in reverse. Getting
    // this backwards puts the drop at the head and shadows every accept.
    nftReturns('');
    await addHostIsolationRules('172.31.0.5', ['172.31.0.1:53', '*:10143'], 'saddr');

    const landed = issued()
      .filter((argv) => argv[0] === 'insert')
      .map((argv) => argv.slice(5))
      .reverse();
    expect(landed).toEqual(
      buildHostAccessRuleOps(['ip', 'saddr', '172.31.0.5'], ['172.31.0.1:53', '*:10143']),
    );
    expect(landed.at(-1)).toEqual(['ip', 'saddr', '172.31.0.5', 'drop']);
  });

  it('ensures the input chain and pre-cleans the identifier before inserting', async () => {
    // Bridge networks recycle addresses, so the previous holder's accepts would
    // otherwise be inherited by the next container on that IP.
    nftReturns('  ip saddr 172.31.0.5 accept # handle 42\n');
    await addHostIsolationRules('172.31.0.5', ['*:10143'], 'saddr');

    const argvs = issued();
    expect(argvs.some((a) => a[0] === 'add' && a.includes('input'))).toBe(true);
    expect(argvs.some((a) => a[0] === 'delete' && a.includes('42'))).toBe(true);
    const deleteAt = argvs.findIndex((a) => a[0] === 'delete');
    const insertAt = argvs.findIndex((a) => a[0] === 'insert');
    expect(deleteAt).toBeLessThan(insertAt);
  });

  it('writes to the input chain of the configured table', async () => {
    nftReturns('');
    await addHostIsolationRules('172.31.0.5', ['*:10143'], 'saddr', { table: 'kici_b' });
    for (const argv of issued().filter((a) => a[0] === 'insert')) {
      expect(argv.slice(1, 5)).toEqual(['rule', 'ip', 'kici_b', 'input']);
    }
  });

  it('matches on the interface when asked to', async () => {
    nftReturns('');
    await addHostIsolationRules('kici-a1b2c3d4', ['*:10143'], 'iifname');
    const landed = issued()
      .filter((argv) => argv[0] === 'insert')
      .map((argv) => argv.slice(5));
    expect(landed.every((r) => r[0] === 'iifname' && r[1] === 'kici-a1b2c3d4')).toBe(true);
  });
});

describe('removeHostIsolationRules', () => {
  it('deletes highest handle first so earlier deletions cannot shift the rest', async () => {
    nftReturns(
      '  ip saddr 172.31.0.5 tcp dport 53 accept # handle 7\n' +
        '  ip saddr 172.31.0.5 drop # handle 9\n',
    );
    await removeHostIsolationRules('172.31.0.5');
    const deletes = mockExecFile.mock.calls
      .map((c) => c[1] as string[])
      .filter((a) => a[0] === 'delete')
      .map((a) => a.at(-1));
    expect(deletes).toEqual(['9', '7']);
  });

  it('is a no-op when the chain does not exist yet', async () => {
    // A teardown must not throw because the table was never created.
    nftFails('No such file or directory');
    await expect(removeHostIsolationRules('172.31.0.5')).resolves.toBeUndefined();
  });
});

describe('readForwardChain', () => {
  it('reads a table with no forward chain as no rules rather than throwing', async () => {
    // nft answers a missing table or chain with "No such file or directory".
    // A caller checking whether its rule set is installed has to read that as
    // NOT installed and go install it; a throw aborts the whole ensure path.
    nftFails('No such file or directory');
    await expect(readForwardChain({ table: 'kici_fc_e2e' })).resolves.toBeNull();
  });

  it('returns the chain text verbatim when the chain is there', async () => {
    // The control for the case above: a helper that answered null for
    // everything would satisfy it and break every presence check.
    nftReturns('  ip saddr 172.31.0.5 drop # handle 9\n');
    await expect(readForwardChain()).resolves.toBe('  ip saddr 172.31.0.5 drop # handle 9\n');
  });

  it('distinguishes a missing chain from an empty one', async () => {
    nftReturns('table ip kici {\n\tchain forward {\n\t}\n}\n');
    const empty = await readForwardChain();
    expect(empty).not.toBeNull();
    expect(parseRuleHandles(empty!, '172.31.0.5')).toEqual([]);
  });
});

describe('removeIsolationRules', () => {
  it('is a no-op when the chain does not exist yet', async () => {
    // A teardown must not throw because the table was never created.
    nftFails('No such file or directory');
    await expect(removeIsolationRules('172.31.0.5')).resolves.toBeUndefined();
    const deletes = mockExecFile.mock.calls
      .map((c) => c[1] as string[])
      .filter((a) => a[0] === 'delete');
    expect(deletes).toEqual([]);
  });
});
