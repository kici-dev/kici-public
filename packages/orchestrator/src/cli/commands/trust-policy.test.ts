import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildPolicyPatch, formatPolicy, type TrustPolicyView } from './trust-policy.js';
import { TrustPolicyEnforcement } from '../../security/trust-policy-gate.js';

const VIEW: TrustPolicyView = {
  customerId: 'org-1',
  forkPolicy: 'hold',
  unknownContributorPolicy: 'reject',
  workflowChangePolicy: 'allow',
  approvalExpiryHours: 72,
  enforcement: TrustPolicyEnforcement.enum.policy,
  source: 'platform',
  updatedAt: '2026-07-29T06:00:00.000Z',
  platformManaged: true,
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
  it('renders every policy value plus provenance', () => {
    const out = formatPolicy(VIEW, 'table');
    expect(out).toContain('Fork PR policy:');
    expect(out).toContain('hold');
    expect(out).toContain('Unknown contributor policy:');
    expect(out).toContain('Workflow change policy:');
    expect(out).toContain('72 h');
    expect(out).toContain('managed by the KiCI Platform');
    expect(out).toContain('2026-07-29T06:00:00.000Z');
  });

  it('prints no policy values when only legacy enforcement is in force', () => {
    // The route omits the four policy fields in legacy mode, so this is the
    // shape the CLI actually receives. Printing a fabricated `hold` here would
    // tell the operator fork PRs are held when they are not.
    const out = formatPolicy(
      {
        customerId: 'org-1',
        enforcement: TrustPolicyEnforcement.enum.legacy,
        source: null,
        platformManaged: false,
        updatedAt: null,
      },
      'table',
    );
    expect(out).toContain('legacy');
    expect(out).toContain('never');
    expect(out).not.toContain('Fork PR policy');
    expect(out).not.toContain('Unknown contributor policy');
    expect(out).not.toContain('Workflow change policy');
    expect(out).not.toContain('Approval expiry');
    // And nothing renders as a literal `undefined`.
    expect(out).not.toContain('undefined');
    // `none (defaults)` would contradict the Enforcement row: in legacy mode no
    // policy is stored AND no defaults are being applied.
    expect(out).not.toContain('(defaults)');
    expect(out).toContain('none (no policy stored)');
  });

  it('still labels an absent source as defaults under policy enforcement', () => {
    // A Platform-attached orchestrator with no stored row DOES apply the
    // fail-closed defaults, so the `(defaults)` wording is only wrong in legacy
    // mode — this pins that the legacy-only rewording did not swallow it here.
    const out = formatPolicy({ ...VIEW, source: null, platformManaged: false }, 'table');
    expect(out).toContain('none (defaults)');
  });

  it('emits JSON when asked', () => {
    expect(JSON.parse(formatPolicy(VIEW, 'json'))).toMatchObject({ forkPolicy: 'hold' });
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

  it('omits flags that were not passed', () => {
    expect(buildPolicyPatch({ forkPolicy: 'allow' })).toEqual({ forkPolicy: 'allow' });
  });

  it('is empty when nothing was passed', () => {
    expect(buildPolicyPatch({})).toEqual({});
  });

  it('rejects an unknown policy value and names the accepted ones', () => {
    const msg = expectExit(() => buildPolicyPatch({ forkPolicy: 'whatever' }));
    expect(msg).toContain('hold | reject | allow');
  });

  it('rejects `allow` for the unknown-contributor policy', () => {
    // The wire enum has no `allow` member; offering it would produce a value
    // the Platform can never send and the route would refuse.
    const msg = expectExit(() => buildPolicyPatch({ unknownContributorPolicy: 'allow' }));
    expect(msg).toContain('hold | reject');
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects approval expiry %s', (value) => {
    expectExit(() => buildPolicyPatch({ approvalExpiryHours: value }));
  });
});
