import { describe, it, expect } from 'vitest';
import {
  KNOWN_LINUX_CAPABILITIES,
  canonicalizeCapability,
  isKnownCapability,
} from './capabilities.js';

describe('sandbox capabilities', () => {
  it('canonicalizes to the bare uppercase Docker-API form', () => {
    expect(canonicalizeCapability('cap_net_admin')).toBe('NET_ADMIN');
    expect(canonicalizeCapability('NET_ADMIN')).toBe('NET_ADMIN');
    expect(canonicalizeCapability('  CAP_SYS_ADMIN  ')).toBe('SYS_ADMIN');
  });
  it('recognizes known caps in either form and rejects unknown', () => {
    expect(isKnownCapability('NET_ADMIN')).toBe(true);
    expect(isKnownCapability('CAP_NET_ADMIN')).toBe(true);
    expect(isKnownCapability('DEFINITELY_NOT_A_CAP')).toBe(false);
    expect(isKnownCapability('')).toBe(false);
  });
  it('holds the full modern capability set (41 caps through CHECKPOINT_RESTORE)', () => {
    expect(KNOWN_LINUX_CAPABILITIES.has('CHOWN')).toBe(true);
    expect(KNOWN_LINUX_CAPABILITIES.has('CHECKPOINT_RESTORE')).toBe(true);
    expect(KNOWN_LINUX_CAPABILITIES.size).toBe(41);
  });
});
