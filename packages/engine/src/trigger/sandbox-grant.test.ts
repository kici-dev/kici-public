import { describe, it, expect } from 'vitest';
import { SANDBOX_NETWORK_MODES } from '../index.js';
import type { ResolvedSandboxGrant, SandboxNetworkMode } from '../index.js';

describe('ResolvedSandboxGrant engine type', () => {
  it('accepts the two-lever grant shape', () => {
    const g: ResolvedSandboxGrant = { capabilities: ['NET_ADMIN'], network: 'host' };
    const n: SandboxNetworkMode = 'none';
    expect(g.capabilities).toEqual(['NET_ADMIN']);
    expect(n).toBe('none');
  });
  it('exposes the network-mode union as a value', () => {
    expect(SANDBOX_NETWORK_MODES).toEqual(['default', 'none', 'host']);
  });
});
