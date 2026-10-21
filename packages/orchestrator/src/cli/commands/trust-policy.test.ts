import { describe, expect, it, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { CiTrustLevel, ForkPolicy } from '@kici-dev/engine';
import {
  buildPolicyPatch,
  formatDirectory,
  formatPolicy,
  formatExpiry,
  registerTrustPolicyCommands,
  type TrustDirectoryView,
  type TrustPolicyView,
} from './trust-policy.js';
import type { AdminApiClient } from '../api-client.js';

const VIEW: TrustPolicyView = {
  customerId: 'org-1',
  forkPolicy: 'hold',
  approvalExpirySeconds: 72 * 3600,
  source: 'platform',
  updatedAt: '2026-07-29T06:00:00.000Z',
  platformManaged: true,
};

const DIRECTORY: TrustDirectoryView = {
  customerId: 'org-1',
  identityLinks: [
    { userId: 'user-1', provider: 'github', providerUsername: 'alice', providerUserId: '4242' },
    { userId: 'user-2', provider: 'github', providerUsername: 'bob', providerUserId: null },
  ],
  memberCiTrustLevels: { 'user-1': 'admin', 'user-2': 'read' },
  teamMemberships: [{ teamName: 'platform', memberUserIds: ['user-1', 'user-2'] }],
  updatedAt: '2026-08-27T06:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `fn`, capturing a `process.exit(1)` as a thrown marker. */
function expectExit(fn: () => void): string {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
  expect(fn).toThrow('__exit__');
  expect(exit).toHaveBeenCalledWith(1);
  return err.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('formatPolicy', () => {
  it('renders the enforced policy plus provenance', () => {
    const out = formatPolicy(VIEW, 'table');
    expect(out).toContain('Fork PR policy:');
    expect(out).toContain('hold');
    expect(out).toContain('72h');
    expect(out).toContain('managed by the KiCI Platform');
    expect(out).toContain('2026-07-29T06:00:00.000Z');
  });

  it('renders `unknown` rather than `undefined` for a field an older route omitted', () => {
    const out = formatPolicy(
      { customerId: 'org-1', source: null, platformManaged: false, updatedAt: null },
      'table',
    );
    expect(out).toContain('Fork PR policy:');
    expect(out).toContain('unknown');
    expect(out).not.toContain('undefined');
    expect(out).toContain('never');
  });

  it('says no policy is stored when an older route sent no policy fields', () => {
    // A v0.5.0 INDEPENDENT orchestrator with no row resolves no policy and
    // omits the fields: nothing is stored and no defaults apply.
    const out = formatPolicy(
      { customerId: 'org-1', source: null, platformManaged: false, updatedAt: null },
      'table',
    );
    expect(out).toContain('none (no policy stored)');
    expect(out).not.toContain('(defaults)');
  });

  it('labels an absent source as defaults when the fields did arrive', () => {
    // A row-less orchestrator on this build applies and sends the fail-closed defaults.
    const out = formatPolicy({ ...VIEW, source: null, platformManaged: false }, 'table');
    expect(out).toContain('none (defaults)');
    expect(out).not.toContain('no policy stored');
  });

  it('warns that an ignore policy drops fork PRs with no contributor-visible trace', () => {
    const out = formatPolicy({ ...VIEW, forkPolicy: ForkPolicy.enum.ignore }, 'table');
    expect(out).toContain('drops fork pull requests before dispatch');
    expect(out).toContain('contributor sees nothing');
    expect(out).toContain('kici_orch_fork_events_ignored_total');
    // `show`, not `list`: the list table has no error column, so no reasons.
    expect(out).toContain('kici-admin event-log show');
    expect(out).not.toContain('kici-admin event-log list');
  });

  it('does not warn under a policy that leaves the contributor something to see', () => {
    // Non-vacuity: `hold` and `allow` produce a run or a check, so an
    // unconditional warning fails here.
    for (const value of [ForkPolicy.enum.hold, ForkPolicy.enum.allow]) {
      const out = formatPolicy({ ...VIEW, forkPolicy: value }, 'table');
      expect(out, `forkPolicy ${value}`).not.toContain('drops fork pull requests');
    }
  });

  it('says nobody chose the drop when no policy is stored, and names the setter', () => {
    const platform = formatPolicy(
      { ...VIEW, forkPolicy: ForkPolicy.enum.ignore, effectiveDefault: true },
      'table',
    );
    expect(platform).toContain('a default nobody chose');
    expect(platform).toContain('Settings > CI trust');

    // The dashboard cannot set an independent orchestrator and the route 409s
    // on a Platform-attached one, so the remedy follows the mode.
    const independent = formatPolicy(
      {
        ...VIEW,
        forkPolicy: ForkPolicy.enum.ignore,
        effectiveDefault: true,
        platformManaged: false,
      },
      'table',
    );
    expect(independent).toContain('kici-admin trust-policy set');
    expect(independent).not.toContain('Settings > CI trust');
  });

  it('does not claim nobody chose a policy the org actually stored', () => {
    const out = formatPolicy(
      { ...VIEW, forkPolicy: ForkPolicy.enum.ignore, effectiveDefault: false },
      'table',
    );
    expect(out).toContain('drops fork pull requests before dispatch');
    expect(out).not.toContain('nobody chose');
  });

  it('emits JSON when asked', () => {
    expect(JSON.parse(formatPolicy(VIEW, 'json'))).toMatchObject({
      forkPolicy: 'hold',
      approvalExpirySeconds: 72 * 3600,
    });
  });
});

describe('buildPolicyPatch', () => {
  it('maps kebab flags onto the wire field names', () => {
    expect(buildPolicyPatch({ forkPolicy: 'hold', approvalExpiry: '12h' })).toEqual({
      forkPolicy: 'hold',
      approvalExpirySeconds: 12 * 3600,
    });
  });

  it('accepts `ignore`, the value an orchestrator with no stored row applies', () => {
    expect(buildPolicyPatch({ forkPolicy: ForkPolicy.enum.ignore })).toEqual({
      forkPolicy: 'ignore',
    });
  });

  it.each(ForkPolicy.options)('accepts fork policy %s', (value) => {
    expect(buildPolicyPatch({ forkPolicy: value })).toEqual({ forkPolicy: value });
  });

  it('omits flags that were not passed', () => {
    expect(buildPolicyPatch({ forkPolicy: 'allow' })).toEqual({ forkPolicy: 'allow' });
  });

  it('is empty when nothing was passed', () => {
    expect(buildPolicyPatch({})).toEqual({});
  });

  it('rejects an unknown policy value and names the accepted ones', () => {
    const msg = expectExit(() => buildPolicyPatch({ forkPolicy: 'whatever' }));
    expect(msg).toContain(ForkPolicy.options.join(' | '));
  });

  it('rejects the removed `reject` fork-policy value', () => {
    // fails-when: the retired value is offered again — the wire enum no longer
    // carries it, so the route would refuse the patch.
    const msg = expectExit(() => buildPolicyPatch({ forkPolicy: 'reject' }));
    expect(msg).toContain(ForkPolicy.options.join(' | '));
  });

  it('ignores the removed non-fork arms rather than sending them', () => {
    // fails-when: a stale flag value reaches the PATCH body.
    expect(
      buildPolicyPatch({ unknownContributorPolicy: 'hold', workflowChangePolicy: 'allow' }),
    ).toEqual({});
  });

  it.each(['0s', '-1h', '1.5h', '72', 'abc', '8761h'])('rejects approval expiry %s', (value) => {
    // fails-when: a malformed or out-of-range duration reaches the PATCH body.
    const msg = expectExit(() => buildPolicyPatch({ approvalExpiry: value }));
    expect(msg).toContain('--approval-expiry:');
  });

  it('sends --approval-expiry 90m as approvalExpirySeconds 5400', () => {
    // breaks-if-wrong: a sub-hour window must still reach the route exactly.
    expect(buildPolicyPatch({ approvalExpiry: '90m' })).toEqual({ approvalExpirySeconds: 5400 });
    expect(buildPolicyPatch({ approvalExpiry: '30s' })).toEqual({ approvalExpirySeconds: 30 });
  });
});

describe('formatExpiry', () => {
  it('renders the window in the duration spelling the flag takes', () => {
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 72 * 3600 })).toBe('72h');
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 5400 })).toBe('1h30m');
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 30 })).toBe('30s');
  });

  it('says unknown when the policy carries no window at all', () => {
    // A v0.5.0 independent orchestrator, which resolved no policy.
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: undefined })).toBe('unknown');
  });
});

describe('formatDirectory', () => {
  it('lists every link, trust level, and team', () => {
    const out = formatDirectory({ directory: DIRECTORY, platformManaged: true }, 'table');
    expect(out).toContain('2026-08-27T06:00:00.000Z');
    expect(out).toContain('the KiCI Platform (read-only here)');
    expect(out).toContain('github:alice -> user-1 (id 4242)');
    // A link predating the immutable-id column renders its absence, not `null`.
    expect(out).toContain('github:bob -> user-2 (id -)');
    expect(out).toContain('user-1 -> admin');
    expect(out).toContain('platform (2 member(s))');
    expect(out).not.toContain('undefined');
  });

  it('explains an empty directory and what it costs', () => {
    const out = formatDirectory({ directory: null, platformManaged: true }, 'table');
    expect(out).toContain('No approval directory is stored');
    expect(out).toContain('the KiCI Platform (read-only here)');
    expect(out).toContain('/kici approve');
    // A Platform-attached orchestrator waits for a push, so no writer is named.
    expect(out).toContain('control-plane handshake');
    expect(out).not.toContain('directory-set');
  });

  it('points an independent orchestrator at its own writer', () => {
    // An independent orchestrator never receives a push, so its remedy differs.
    const out = formatDirectory({ directory: null, platformManaged: false }, 'table');
    expect(out).toContain('nothing will ever be pushed here');
    expect(out).toContain('kici-admin trust-policy directory-set');
    expect(out).not.toContain('control-plane handshake');
  });

  it('names the operator as the writer on an independent orchestrator', () => {
    const out = formatDirectory({ directory: DIRECTORY, platformManaged: false }, 'table');
    expect(out).toMatch(/Written by: +this orchestrator's operator/);
    expect(out).not.toContain('the KiCI Platform');
  });

  it('emits JSON when asked', () => {
    expect(
      JSON.parse(formatDirectory({ directory: DIRECTORY, platformManaged: true }, 'json')),
      // The whole envelope, so a script can read `platformManaged` too.
    ).toMatchObject({ platformManaged: true, directory: { customerId: 'org-1' } });
  });
});

/**
 * An age beside the stored timestamp, and a note whose severity tracks whether
 * a refresh can arrive. The disconnected case is covered here only: end to end
 * it would need a partitioned live Platform, so the end-to-end suite asserts
 * the connected one.
 */
describe('formatDirectory staleness rendering', () => {
  /** Three days after DIRECTORY.updatedAt. */
  const NOW = Date.parse('2026-08-30T06:00:00.000Z');

  /** One line, so a phrase assertion survives re-wrapping. */
  const flat = (out: string): string => out.replace(/\s+/g, ' ');

  it('renders the age beside the stored timestamp', () => {
    const out = formatDirectory({ directory: DIRECTORY, platformManaged: true }, 'table', NOW);
    // The absolute time stays — it is what correlates with a Platform change.
    expect(out).toContain('2026-08-27T06:00:00.000Z (3d 0h 0m ago)');
  });

  it('renders a fresh directory in seconds rather than days', () => {
    const out = formatDirectory(
      { directory: DIRECTORY, platformManaged: true, platformConnected: true },
      'table',
      Date.parse('2026-08-27T06:00:42.000Z'),
    );
    expect(out).toContain('(42s ago)');
  });

  it('clamps a directory written in the future rather than rendering a negative age', () => {
    // Orchestrator and CLI clocks differ; a backwards skew must not render `-5s ago`.
    const out = formatDirectory(
      { directory: DIRECTORY, platformManaged: true },
      'table',
      Date.parse('2026-08-27T05:59:55.000Z'),
    );
    expect(out).toContain('(0s ago)');
    expect(out).not.toMatch(/\(-\d/);
  });

  it('renders an unparseable timestamp alone rather than as NaN', () => {
    const out = formatDirectory(
      { directory: { ...DIRECTORY, updatedAt: 'not-a-date' }, platformManaged: true },
      'table',
      NOW,
    );
    expect(out).toContain('Stored at:');
    expect(out).toContain('not-a-date');
    expect(out).not.toContain('NaN');
  });

  it('states the propagation delay when the Platform connection is up', () => {
    const out = formatDirectory(
      { directory: DIRECTORY, platformManaged: true, platformConnected: true },
      'table',
      NOW,
    );
    expect(out).toContain('Note:');
    expect(flat(out)).toContain("reaches this orchestrator on the Platform's next push");
    expect(out).toContain('kici_orch_trust_directory_age_seconds');
    // A connected orchestrator lags one push at most, so no escalation.
    expect(out).not.toContain('Warning:');
    expect(out).not.toContain('unbounded');
  });

  it('escalates to a warning naming the unbounded window when the Platform is unreachable', () => {
    const out = formatDirectory(
      { directory: DIRECTORY, platformManaged: true, platformConnected: false },
      'table',
      NOW,
    );
    expect(out).toContain('Warning:');
    expect(flat(out)).toContain('the Platform connection is down, so no push can arrive');
    expect(flat(out)).toContain('That window is unbounded');
    // Deliberate: not a bug to fix by expiring the cache.
    expect(flat(out)).toContain('deliberately never expired');
  });

  it('does not escalate when the orchestrator reports no connection state', () => {
    // An orchestrator without `platformConnected` sends nothing: unknown, not down.
    const out = formatDirectory({ directory: DIRECTORY, platformManaged: true }, 'table', NOW);
    expect(out).toContain('Note:');
    expect(out).not.toContain('Warning:');
  });

  it('says nothing at all on an independent orchestrator', () => {
    // The reader wrote the directory; there is no upstream to lag behind.
    const out = formatDirectory(
      { directory: DIRECTORY, platformManaged: false, platformConnected: false },
      'table',
      NOW,
    );
    expect(out).toContain('(3d 0h 0m ago)');
    expect(out).not.toContain('Note:');
    expect(out).not.toContain('Warning:');
  });

  it('says nothing when no directory has ever been stored', () => {
    // The absence wording covers it; a missing directory has no age.
    const out = formatDirectory(
      { directory: null, platformManaged: true, platformConnected: false },
      'table',
      NOW,
    );
    expect(out).toContain('No approval directory is stored');
    expect(out).not.toContain('unbounded');
  });

  it('leaves JSON output untouched by the age and the note', () => {
    // `--format json` is a script contract: the CLI-side age stays out of the route's body.
    const parsed = JSON.parse(
      formatDirectory(
        { directory: DIRECTORY, platformManaged: true, platformConnected: false },
        'json',
        NOW,
      ),
    ) as { directory: { updatedAt: string } };
    expect(parsed.directory.updatedAt).toBe('2026-08-27T06:00:00.000Z');
  });
});

/**
 * The registration seam: the formatter tests miss a wrong path, a dropped flag
 * or a missing registration, so these drive the real Commander action with a
 * stub client and assert the exact request.
 */
describe('registerTrustPolicyCommands', () => {
  afterEach(() => vi.restoreAllMocks());

  const EMPTY_DIRECTORY_RESPONSE = {
    directory: {
      customerId: 'org-1',
      identityLinks: [],
      memberCiTrustLevels: {},
      teamMemberships: [],
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    platformManaged: false,
  };

  function harness(response: unknown = EMPTY_DIRECTORY_RESPONSE) {
    const patch = vi.fn().mockResolvedValue(response);
    const del = vi.fn().mockResolvedValue(response);
    const program = new Command();
    program.exitOverride();
    registerTrustPolicyCommands(
      program,
      () => ({ patch, delete: del }) as unknown as AdminApiClient,
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { program, patch, delete: del };
  }

  const SET_ARGV = [
    'node',
    'kici-admin',
    'trust-policy',
    'directory-set',
    '--org',
    'org-1',
    '--user-id',
    'user-7',
    '--provider-username',
    'carol',
    '--provider-user-id',
    '7070',
    '--ci-trust',
    'write',
  ];

  it('set sends --approval-expiry as seconds and refuses the retired hours flag', async () => {
    const { program, patch } = harness({ policy: { ...VIEW, approvalExpirySeconds: 5400 } });
    await program.parseAsync([
      'node',
      'kici-admin',
      'trust-policy',
      'set',
      '--org',
      'org-1',
      '--approval-expiry',
      '90m',
    ]);
    expect(patch).toHaveBeenCalledWith('/api/v1/admin/trust-policy', {
      customerId: 'org-1',
      approvalExpirySeconds: 5400,
    });
    // fails-when: --approval-expiry-hours is still a registered option.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      harness().program.parseAsync([
        'node',
        'kici-admin',
        'trust-policy',
        'set',
        '--org',
        'org-1',
        '--approval-expiry-hours',
        '72',
      ]),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });

  it('registers every leaf, including the two directory writers', () => {
    const { program } = harness();
    const group = program.commands.find((c) => c.name() === 'trust-policy');
    expect(group!.commands.map((c) => c.name()).sort()).toEqual([
      'directory',
      'directory-remove',
      'directory-set',
      'set',
      'show',
    ]);
  });

  it('directory-set PATCHes the directory route with the whole registration', async () => {
    const { program, patch } = harness();
    await program.parseAsync(SET_ARGV);
    expect(patch).toHaveBeenCalledWith('/api/v1/admin/trust-policy/directory', {
      customerId: 'org-1',
      userId: 'user-7',
      // Defaulted: a link without a provider matches no comment.
      provider: 'github',
      providerUsername: 'carol',
      providerUserId: '7070',
      ciTrust: 'write',
    });
  });

  it('directory-set requires the provider numeric id', async () => {
    // Commander refuses before any request, so omission cannot create an inert link.
    const { program, patch } = harness();
    const argv = SET_ARGV.filter(
      (a, i) => a !== '--provider-user-id' && SET_ARGV[i - 1] !== '--provider-user-id',
    );
    await expect(program.parseAsync(argv)).rejects.toThrow(/provider-user-id/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('directory-set rejects a CI trust level outside the four known ones', async () => {
    const { program, patch } = harness();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const argv = [...SET_ARGV.slice(0, -1), 'superuser'];
    await expect(program.parseAsync(argv)).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(patch).not.toHaveBeenCalled();
    // The message names what IS accepted.
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(
      CiTrustLevel.options.join(' | '),
    );
  });

  it('directory-remove DELETEs with both ids url-encoded', async () => {
    const { program, delete: del } = harness({ ...EMPTY_DIRECTORY_RESPONSE, removed: true });
    await program.parseAsync([
      'node',
      'kici-admin',
      'trust-policy',
      'directory-remove',
      '--org',
      'org/1',
      '--user-id',
      'user 7',
    ]);
    expect(del).toHaveBeenCalledWith(
      '/api/v1/admin/trust-policy/directory?customerId=org%2F1&userId=user%207',
    );
  });

  it('directory-remove says so when the member held nothing', async () => {
    const { program } = harness({ ...EMPTY_DIRECTORY_RESPONSE, removed: false });
    await program.parseAsync([
      'node',
      'kici-admin',
      'trust-policy',
      'directory-remove',
      '--org',
      'org-1',
      '--user-id',
      'ghost',
    ]);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('nothing to do');
  });

  it('directory-set surfaces the route refusal verbatim and exits non-zero', async () => {
    // The 409 wording is the server's; rewording it here would drift.
    const message = 'The approval directory is managed by the KiCI Platform for this orchestrator.';
    const { program } = harness();
    const patch = vi.fn().mockRejectedValue(new Error(message));
    const prog = new Command();
    prog.exitOverride();
    registerTrustPolicyCommands(prog, () => ({ patch }) as unknown as AdminApiClient);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(prog.parseAsync(SET_ARGV)).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(message);
    void program;
  });
});

describe('trust-policy show org split notes', () => {
  afterEach(() => vi.restoreAllMocks());

  const ORGS = {
    platformAttachment: 'attached',
    attachedOrgId: 'org_A',
    orgs: [
      { orgId: '__default__', sources: ['source'] },
      { orgId: 'org_A', sources: ['platform', 'source'] },
    ],
  };

  async function show(org: string, format: string, orgList: () => Promise<unknown>) {
    const get = vi.fn(async (path: string) =>
      path === '/api/v1/admin/org-ids' ? orgList() : { policy: VIEW },
    );
    const program = new Command();
    program.exitOverride();
    registerTrustPolicyCommands(program, () => ({ get }) as unknown as AdminApiClient);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
    await program.parseAsync([
      'node',
      'kici-admin',
      'trust-policy',
      'show',
      '--org',
      org,
      '--format',
      format,
    ]);
    return { stdout: out.join('\n'), stderr: err.join('\n'), get };
  }

  it('says the attached org policy does not reach sources in another org', async () => {
    // fails-when: the attached org's policy reads as the one every source uses.
    const { stderr } = await show('org_A', 'table', async () => ORGS);
    expect(stderr).toContain("sources in org(s) '__default__' do not use this policy");
  });

  it('says a foreign source org uses its own policy, not the Platform-managed one', async () => {
    const { stderr } = await show('__default__', 'table', async () => ORGS);
    expect(stderr).toContain("attached to org 'org_A', whose policy the Platform manages");
    expect(stderr).toContain("Sources in org '__default__' use this policy instead.");
  });

  it('prints no note when the org listing cannot be read', async () => {
    const { stderr } = await show('org_A', 'table', async () => {
      throw new Error('HTTP 404');
    });
    expect(stderr).toBe('');
  });

  it('keeps --format json output unchanged and reads no org listing', async () => {
    // breaks-if-wrong: scripts parsing the JSON see exactly the policy.
    const { stdout, stderr, get } = await show('org_A', 'json', async () => ORGS);
    expect(stdout).toBe(formatPolicy(VIEW, 'json'));
    expect(stderr).toBe('');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
