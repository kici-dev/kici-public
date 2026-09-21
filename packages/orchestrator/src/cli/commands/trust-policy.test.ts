import { describe, expect, it, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { CiTrustLevel, ForkPolicy } from '@kici-dev/engine';
import {
  buildPolicyPatch,
  formatDirectory,
  formatPolicy,
  formatExpiry,
  policyExpiryWarnings,
  registerTrustPolicyCommands,
  type TrustDirectoryView,
  type TrustPolicyView,
} from './trust-policy.js';
import type { AdminApiClient } from '../api-client.js';

const VIEW: TrustPolicyView = {
  customerId: 'org-1',
  forkPolicy: 'hold',
  approvalExpiryHours: 72,
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
    expect(out).toContain('72 h');
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
    // The shape a v0.5.0 INDEPENDENT orchestrator with no stored row returns:
    // it resolved no policy at all, so it omitted the four fields. `(defaults)`
    // would be wrong twice over there — nothing is stored, and no defaults are
    // being applied either.
    const out = formatPolicy(
      { customerId: 'org-1', source: null, platformManaged: false, updatedAt: null },
      'table',
    );
    expect(out).toContain('none (no policy stored)');
    expect(out).not.toContain('(defaults)');
  });

  it('labels an absent source as defaults when the fields did arrive', () => {
    // A row-less orchestrator on this build DOES apply the fail-closed defaults
    // and sends them, so `(defaults)` is the honest wording here.
    const out = formatPolicy({ ...VIEW, source: null, platformManaged: false }, 'table');
    expect(out).toContain('none (defaults)');
    expect(out).not.toContain('no policy stored');
  });

  it('warns that an ignore policy drops fork PRs with no contributor-visible trace', () => {
    const out = formatPolicy({ ...VIEW, forkPolicy: ForkPolicy.enum.ignore }, 'table');
    expect(out).toContain('drops fork pull requests before dispatch');
    expect(out).toContain('contributor sees nothing');
    // Where to look for an individual drop, so the warning is actionable.
    expect(out).toContain('kici_orch_fork_events_ignored_total');
    // `show`, not `list`: the list table has no error column, so an operator
    // sent there would find every drop row and none of the reasons.
    expect(out).toContain('kici-admin event-log show');
    expect(out).not.toContain('kici-admin event-log list');
  });

  it('does not warn under a policy that leaves the contributor something to see', () => {
    // Non-vacuity for the three cases above: `hold` and `allow` both produce a
    // run or a check, so a build that warned unconditionally would fail here.
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

    // An independent orchestrator cannot be set from the dashboard, and the
    // route 409s on a Platform-attached one — so the remedy has to follow the
    // mode rather than name one verb for both.
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
      approvalExpiryHours: 72,
    });
  });
});

describe('buildPolicyPatch', () => {
  it('maps kebab flags onto the wire field names', () => {
    expect(buildPolicyPatch({ forkPolicy: 'hold', approvalExpiryHours: '12' })).toEqual({
      forkPolicy: 'hold',
      approvalExpiryHours: 12,
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

  it.each(['0', '-1', '1.5', 'abc'])('rejects approval expiry %s', (value) => {
    expectExit(() => buildPolicyPatch({ approvalExpiryHours: value }));
  });

  it('accepts a seconds window', () => {
    expect(buildPolicyPatch({ approvalExpirySeconds: '30' })).toEqual({
      approvalExpirySeconds: 30,
    });
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects approval expiry seconds %s', (value) => {
    // Same floor and the same two reasons as the hours flag: the column is
    // INTEGER, and a non-positive window mints an already-expired hold.
    const msg = expectExit(() => buildPolicyPatch({ approvalExpirySeconds: value }));
    expect(msg).toContain('--approval-expiry-seconds must be an integer >= 1');
  });

  it('carries both spellings through when both are given', () => {
    // The route, not the CLI, decides which wins; the CLI warns (below).
    expect(buildPolicyPatch({ approvalExpiryHours: '72', approvalExpirySeconds: '30' })).toEqual({
      approvalExpiryHours: 72,
      approvalExpirySeconds: 30,
    });
  });
});

describe('formatExpiry', () => {
  it('renders a whole-hour window in hours, exactly as it always did', () => {
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 72 * 3600 })).toBe('72 h');
  });

  it('renders a sub-hour window in seconds rather than rounding it', () => {
    // Rounding would print a window the orchestrator is not applying.
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 30 })).toBe('30 s');
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: 5400 })).toBe('5400 s');
  });

  it('falls back to the hours field for an orchestrator that sends no seconds', () => {
    expect(formatExpiry({ ...VIEW, approvalExpirySeconds: undefined })).toBe('72 h');
  });

  it('says unknown when the policy carries no window at all', () => {
    // A v0.5.0 independent orchestrator, which resolved no policy.
    expect(
      formatExpiry({ ...VIEW, approvalExpiryHours: undefined, approvalExpirySeconds: undefined }),
    ).toBe('unknown');
  });
});

describe('policyExpiryWarnings', () => {
  it('names the ignored spelling when both are given', () => {
    expect(policyExpiryWarnings({ approvalExpiryHours: 72, approvalExpirySeconds: 30 })).toEqual([
      'Warning: --approval-expiry-hours 72 is ignored because --approval-expiry-seconds 30 ' +
        'was also given; the more specific value wins.',
    ]);
  });

  it('is silent when only one spelling is given', () => {
    expect(policyExpiryWarnings({ approvalExpiryHours: 72 })).toEqual([]);
    expect(policyExpiryWarnings({ approvalExpirySeconds: 30 })).toEqual([]);
    expect(policyExpiryWarnings({ forkPolicy: 'hold' })).toEqual([]);
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
    // A Platform-attached orchestrator waits for a push; there is nothing the
    // operator can do here, so it must not be told to run the writer.
    expect(out).toContain('control-plane handshake');
    expect(out).not.toContain('directory-set');
  });

  it('points an independent orchestrator at its own writer', () => {
    // The two absences have different remedies. Telling an independent operator
    // to wait for a push that will never come is the wording this replaced.
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
 * The staleness surface: an age beside the stored timestamp, and a note whose
 * severity tracks whether a refresh can arrive at all.
 *
 * The disconnected case is the one the whole feature exists for and is covered
 * here only — reproducing it end-to-end would mean partitioning staging's
 * Platform, so `e2e/tests/ci-security.test.ts` asserts the rendering and says
 * so.
 */
describe('formatDirectory staleness rendering', () => {
  /** Three days after DIRECTORY.updatedAt. */
  const NOW = Date.parse('2026-08-30T06:00:00.000Z');

  /**
   * Collapse the hard-wrapped note into one line, so an assertion on a phrase
   * survives re-wrapping the prose it lives in.
   */
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
    // The write timestamp is the orchestrator's clock and `now` is the CLI
    // host's; a backwards skew must not render `-5s ago`.
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
    // A connected orchestrator is behind by one push, not indefinitely — the
    // escalated wording must not fire here or it stops meaning anything.
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
    // The trade-off is deliberate; the operator must not read this as a bug to
    // fix by expiring the cache.
    expect(flat(out)).toContain('deliberately never expired');
  });

  it('does not escalate when the orchestrator reports no connection state', () => {
    // An orchestrator predating `platformConnected` sends nothing. Absent means
    // unknown, and reading unknown as down would cry outage on every read.
    const out = formatDirectory({ directory: DIRECTORY, platformManaged: true }, 'table', NOW);
    expect(out).toContain('Note:');
    expect(out).not.toContain('Warning:');
  });

  it('says nothing at all on an independent orchestrator', () => {
    // The operator reading this wrote the directory. There is no upstream for
    // it to lag behind, so every wording above would be false.
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
    // The absence wording already explains what to expect; a staleness note
    // about a directory that does not exist would name an age nothing has.
    const out = formatDirectory(
      { directory: null, platformManaged: true, platformConnected: false },
      'table',
      NOW,
    );
    expect(out).toContain('No approval directory is stored');
    expect(out).not.toContain('unbounded');
  });

  it('leaves JSON output untouched by the age and the note', () => {
    // `--format json` is a script contract: the rendered age is a CLI-side
    // computation and must not appear in the body the route returned.
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
 * The registration seam.
 *
 * The formatters above can be perfect while the command that reaches them
 * sends the wrong path, drops a flag, or is never registered at all — and none
 * of the tests above would notice. These drive the real Commander action with a
 * stub client and assert the exact request it produced.
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
    '--customer-id',
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
      // Defaulted, not dropped — the link is per-provider and a missing one
      // would store a link no comment can ever match.
      provider: 'github',
      providerUsername: 'carol',
      providerUserId: '7070',
      ciTrust: 'write',
    });
  });

  it('directory-set requires the provider numeric id', async () => {
    // Commander refuses a missing required option before any request is made,
    // so an inert link cannot be created by omission.
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
    // The message names what IS accepted, so the operator does not have to go
    // read the route schema.
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
      '--customer-id',
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
      '--customer-id',
      'org-1',
      '--user-id',
      'ghost',
    ]);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('nothing to do');
  });

  it('directory-set surfaces the route refusal verbatim and exits non-zero', async () => {
    // The 409 wording is the server's, not the CLI's — reworded here it would
    // drift from what the orchestrator actually decided.
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
