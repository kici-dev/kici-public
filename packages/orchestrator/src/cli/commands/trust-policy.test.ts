import { describe, expect, it, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { CiTrustLevel, ForkPolicy } from '@kici-dev/engine';
import {
  buildPolicyPatch,
  formatDirectory,
  formatPolicy,
  formatExpiry,
  policyDeprecationWarnings,
  policyExpiryWarnings,
  registerTrustPolicyCommands,
  type TrustDirectoryView,
  type TrustPolicyView,
} from './trust-policy.js';
import type { AdminApiClient } from '../api-client.js';

const VIEW: TrustPolicyView = {
  customerId: 'org-1',
  forkPolicy: 'hold',
  unknownContributorPolicy: 'reject',
  workflowChangePolicy: 'allow',
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

  it('omits the two arms nothing enforces', () => {
    // Both are still stored and still echoed back, but no dispatch decision
    // reads either — a row for them would assert an enforcement that is not
    // happening. `--format json` below keeps the values reachable.
    const out = formatPolicy(VIEW, 'table');
    expect(out).not.toContain('Unknown contributor policy');
    expect(out).not.toContain('Workflow change policy');
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

  it('emits JSON when asked, carrying the fields the table omits', () => {
    expect(JSON.parse(formatPolicy(VIEW, 'json'))).toMatchObject({
      forkPolicy: 'hold',
      unknownContributorPolicy: 'reject',
      workflowChangePolicy: 'allow',
    });
  });
});

describe('buildPolicyPatch', () => {
  it('maps kebab flags onto the wire field names', () => {
    expect(
      buildPolicyPatch({
        forkPolicy: 'reject',
        unknownContributorPolicy: 'hold',
        workflowChangePolicy: 'allow',
        approvalExpiryHours: '12',
      }),
    ).toEqual({
      forkPolicy: 'reject',
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'allow',
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

  it('rejects `allow` for the unknown-contributor policy', () => {
    // The wire schema declares no `allow` member for that arm; offering it would
    // produce a value the Platform can never send and the route would refuse.
    const msg = expectExit(() => buildPolicyPatch({ unknownContributorPolicy: 'allow' }));
    expect(msg).toContain('hold | reject');
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

describe('policyDeprecationWarnings', () => {
  it('warns that `reject` is deprecated in favour of `ignore`', () => {
    const [warning, ...rest] = policyDeprecationWarnings({ forkPolicy: ForkPolicy.enum.reject });
    expect(rest).toEqual([]);
    expect(warning).toContain('--fork-policy reject is deprecated');
    expect(warning).toContain('--fork-policy ignore');
  });

  it('says nothing about a live fork-policy value', () => {
    for (const value of [ForkPolicy.enum.ignore, ForkPolicy.enum.hold, ForkPolicy.enum.allow]) {
      expect(policyDeprecationWarnings({ forkPolicy: value })).toEqual([]);
    }
  });

  it('warns that each dead arm is no longer enforced', () => {
    const warnings = policyDeprecationWarnings({
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'allow',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('--unknown-contributor-policy');
    expect(warnings[0]).toContain('no longer enforced; removed at v1.0.0');
    expect(warnings[1]).toContain('--workflow-change-policy');
    expect(warnings[1]).toContain('no longer enforced; removed at v1.0.0');
  });

  it('says nothing for a patch that touches only live fields', () => {
    expect(policyDeprecationWarnings({ forkPolicy: 'hold', approvalExpiryHours: 12 })).toEqual([]);
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
