import { describe, it, expect } from 'vitest';
import { resolveSandboxGrant } from './resolve-sandbox-grant.js';

const deny = (r: unknown): r is { denied: { reason: string } } =>
  typeof r === 'object' && r !== null && 'denied' in r;

describe('resolveSandboxGrant', () => {
  const allow = { capabilities: ['NET_ADMIN'], allowHostNetwork: false };

  it('no request → undefined grant', () => {
    expect(resolveSandboxGrant(undefined, allow)).toEqual({ grant: undefined });
    expect(resolveSandboxGrant({ network: 'default' }, allow)).toEqual({ grant: undefined });
    expect(resolveSandboxGrant({ capabilities: [] }, allow)).toEqual({ grant: undefined });
  });

  it('allow-listed cap (either form) → grant with canonical cap', () => {
    expect(resolveSandboxGrant({ capabilities: ['CAP_NET_ADMIN'] }, allow)).toEqual({
      grant: { capabilities: ['NET_ADMIN'] },
    });
    expect(resolveSandboxGrant({ capabilities: ['net_admin'] }, allow)).toEqual({
      grant: { capabilities: ['NET_ADMIN'] },
    });
  });

  it('non-allow-listed cap → denied naming the cap + knob', () => {
    const r = resolveSandboxGrant({ capabilities: ['SYS_ADMIN'] }, allow);
    expect(
      deny(r) &&
        /SYS_ADMIN/.test(r.denied.reason) &&
        /sandboxAllowedCapabilities/.test(r.denied.reason),
    ).toBe(true);
  });

  it('unknown cap → denied naming it', () => {
    const r = resolveSandboxGrant({ capabilities: ['BOGUS'] }, allow);
    expect(deny(r) && /BOGUS/.test(r.denied.reason)).toBe(true);
  });

  it("network:'none' always allowed (tightening)", () => {
    expect(resolveSandboxGrant({ network: 'none' }, allow)).toEqual({ grant: { network: 'none' } });
  });

  it("network:'host' denied unless allowHostNetwork, and its reason names the knob", () => {
    const r = resolveSandboxGrant({ network: 'host' }, allow);
    expect(deny(r) && /sandboxAllowHostNetwork/.test(r.denied.reason)).toBe(true);
    expect(
      resolveSandboxGrant({ network: 'host' }, { capabilities: [], allowHostNetwork: true }),
    ).toEqual({ grant: { network: 'host' } });
  });

  it('combines an allowed cap and host network into one grant', () => {
    expect(
      resolveSandboxGrant(
        { capabilities: ['CAP_NET_ADMIN'], network: 'host' },
        { capabilities: ['NET_ADMIN'], allowHostNetwork: true },
      ),
    ).toEqual({ grant: { capabilities: ['NET_ADMIN'], network: 'host' } });
  });

  it('denies the whole request if any one capability is not allow-listed (total, not partial)', () => {
    const r = resolveSandboxGrant({ capabilities: ['NET_ADMIN', 'SYS_ADMIN'] }, allow);
    expect(deny(r) && /SYS_ADMIN/.test(r.denied.reason)).toBe(true);
  });
});
