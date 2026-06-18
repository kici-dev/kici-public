import { describe, it, expect } from 'vitest';
import {
  deriveOsArchLabels,
  hostLabel,
  agentTypeLabel,
  scalerLabel,
  mergeAutoLabels,
  normalizeRunsOn,
  KNOWN_ROLES,
  RESERVED_LABEL_PREFIX,
  ROLE_LABEL_PREFIX,
  roleToLabel,
  resolveRoleLabels,
  validateNoReservedLabels,
  isAutoLabel,
  separateLabels,
  scalerAgentLabels,
  isSelfReportedLabel,
} from './labels.js';

describe('deriveOsArchLabels', () => {
  it('maps linux platform', () => {
    const labels = deriveOsArchLabels('linux', 'x64');
    expect(labels).toContain('kici:os:linux');
    expect(labels).toContain('kici:arch:x64');
    expect(labels).toContain('kici:arch:amd64');
  });

  it('maps darwin platform to kici:os:macos + kici:os:darwin', () => {
    const labels = deriveOsArchLabels('darwin', 'arm64');
    expect(labels).toContain('kici:os:macos');
    expect(labels).toContain('kici:os:darwin');
    expect(labels).toContain('kici:arch:arm64');
    expect(labels).not.toContain('kici:os:linux');
  });

  it('maps win32 platform to kici:os:windows + kici:os:win32', () => {
    const labels = deriveOsArchLabels('win32', 'x64');
    expect(labels).toContain('kici:os:windows');
    expect(labels).toContain('kici:os:win32');
    expect(labels).toContain('kici:arch:x64');
    expect(labels).toContain('kici:arch:amd64');
  });

  it('passes through unknown platform with kici:os: prefix', () => {
    const labels = deriveOsArchLabels('freebsd', 'x64');
    expect(labels).toContain('kici:os:freebsd');
  });

  it('passes through unknown arch with kici:arch: prefix', () => {
    const labels = deriveOsArchLabels('linux', 'riscv64');
    expect(labels).toContain('kici:arch:riscv64');
  });
});

describe('hostLabel', () => {
  it('prefixes with kici:host:', () => {
    expect(hostLabel('host-1')).toBe('kici:host:host-1');
  });
});

describe('agentTypeLabel', () => {
  it('prefixes with kici:agent:', () => {
    expect(agentTypeLabel('container')).toBe('kici:agent:container');
    expect(agentTypeLabel('bare-metal')).toBe('kici:agent:bare-metal');
    expect(agentTypeLabel('firecracker')).toBe('kici:agent:firecracker');
  });
});

describe('scalerLabel', () => {
  it('prefixes with kici:scaler:', () => {
    expect(scalerLabel('stg-container')).toBe('kici:scaler:stg-container');
  });
});

describe('mergeAutoLabels', () => {
  it('merges explicit labels with auto labels', () => {
    const result = mergeAutoLabels(['container'], ['kici:os:linux', 'kici:arch:x64']);
    expect(result).toContain('container');
    expect(result).toContain('kici:os:linux');
    expect(result).toContain('kici:arch:x64');
  });

  it('deduplicates', () => {
    const result = mergeAutoLabels(
      ['kici:os:linux', 'bare-metal'],
      ['kici:os:linux', 'kici:arch:x64'],
    );
    const count = result.filter((l) => l === 'kici:os:linux').length;
    expect(count).toBe(1);
  });

  it('handles empty explicit labels', () => {
    const result = mergeAutoLabels([], ['kici:os:macos', 'kici:arch:arm64']);
    expect(result).toEqual(['kici:os:macos', 'kici:arch:arm64']);
  });
});

describe('normalizeRunsOn', () => {
  it('normalizes a string to labels array with empty exclude', () => {
    expect(normalizeRunsOn('linux')).toEqual({ labels: ['linux'], exclude: [] });
  });

  it('normalizes a string array to labels with empty exclude', () => {
    expect(normalizeRunsOn(['linux', 'docker'])).toEqual({
      labels: ['linux', 'docker'],
      exclude: [],
    });
  });

  it('normalizes object with string labels and string exclude', () => {
    expect(normalizeRunsOn({ labels: 'linux', exclude: 'gpu' })).toEqual({
      labels: ['linux'],
      exclude: ['gpu'],
    });
  });

  it('normalizes object with array labels and array exclude', () => {
    expect(normalizeRunsOn({ labels: ['linux', 'docker'], exclude: ['gpu', 'arm64'] })).toEqual({
      labels: ['linux', 'docker'],
      exclude: ['gpu', 'arm64'],
    });
  });

  it('normalizes object with labels only (no exclude)', () => {
    expect(normalizeRunsOn({ labels: 'linux' })).toEqual({
      labels: ['linux'],
      exclude: [],
    });
  });

  it('normalizes object with string labels and array exclude', () => {
    expect(normalizeRunsOn({ labels: 'linux', exclude: ['gpu', 'arm64'] })).toEqual({
      labels: ['linux'],
      exclude: ['gpu', 'arm64'],
    });
  });

  it('normalizes object with array labels and string exclude', () => {
    expect(normalizeRunsOn({ labels: ['linux', 'docker'], exclude: 'gpu' })).toEqual({
      labels: ['linux', 'docker'],
      exclude: ['gpu'],
    });
  });
});

describe('role constants', () => {
  it('KNOWN_ROLES contains exactly builder and init-runner', () => {
    expect(KNOWN_ROLES).toEqual(['builder', 'init-runner']);
  });

  it('RESERVED_LABEL_PREFIX is kici:', () => {
    expect(RESERVED_LABEL_PREFIX).toBe('kici:');
  });

  it('ROLE_LABEL_PREFIX is kici:role:', () => {
    expect(ROLE_LABEL_PREFIX).toBe('kici:role:');
  });
});

describe('roleToLabel', () => {
  it('converts builder to kici:role:builder', () => {
    expect(roleToLabel('builder')).toBe('kici:role:builder');
  });

  it('converts init-runner to kici:role:init-runner', () => {
    expect(roleToLabel('init-runner')).toBe('kici:role:init-runner');
  });
});

describe('resolveRoleLabels', () => {
  it('returns all role labels when undefined (backward compat default)', () => {
    expect(resolveRoleLabels(undefined)).toEqual(['kici:role:builder', 'kici:role:init-runner']);
  });

  it('returns empty array when empty array (execution only)', () => {
    expect(resolveRoleLabels([])).toEqual([]);
  });

  it('returns single role label for builder', () => {
    expect(resolveRoleLabels(['builder'])).toEqual(['kici:role:builder']);
  });

  it('returns single role label for init-runner', () => {
    expect(resolveRoleLabels(['init-runner'])).toEqual(['kici:role:init-runner']);
  });

  it('returns both role labels for builder and init-runner', () => {
    expect(resolveRoleLabels(['builder', 'init-runner'])).toEqual([
      'kici:role:builder',
      'kici:role:init-runner',
    ]);
  });

  it('returns all role labels when all is specified', () => {
    expect(resolveRoleLabels(['all'])).toEqual(['kici:role:builder', 'kici:role:init-runner']);
  });

  it('normalizes to all role labels when all is combined with specific roles', () => {
    expect(resolveRoleLabels(['builder', 'all'])).toEqual([
      'kici:role:builder',
      'kici:role:init-runner',
    ]);
  });
});

describe('validateNoReservedLabels', () => {
  it('does not throw for non-kici labels', () => {
    expect(() => validateNoReservedLabels(['linux', 'docker'], 'test')).not.toThrow();
  });

  it('throws for kici:role: prefixed labels', () => {
    expect(() => validateNoReservedLabels(['kici:role:builder'], 'KICI_LABELS')).toThrow(
      /kici:.*KICI_LABELS/,
    );
  });

  it('throws listing the reserved label', () => {
    expect(() => validateNoReservedLabels(['linux', 'kici:custom:foo'], 'runsOn')).toThrow(
      'kici:custom:foo',
    );
  });

  it('is case-insensitive', () => {
    expect(() => validateNoReservedLabels(['KICI:something'], 'test')).toThrow(/kici:/i);
  });

  it('passes for empty array', () => {
    expect(() => validateNoReservedLabels([], 'test')).not.toThrow();
  });
});

describe('isAutoLabel', () => {
  it('returns true for kici: prefixed labels', () => {
    expect(isAutoLabel('kici:os:linux')).toBe(true);
    expect(isAutoLabel('kici:role:builder')).toBe(true);
    expect(isAutoLabel('kici:host:host-1')).toBe(true);
  });

  it('returns false for user labels', () => {
    expect(isAutoLabel('linux')).toBe(false);
    expect(isAutoLabel('docker')).toBe(false);
    expect(isAutoLabel('gpu')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAutoLabel('KICI:os:linux')).toBe(true);
  });
});

describe('separateLabels', () => {
  it('separates user and auto labels', () => {
    const result = separateLabels([
      'linux',
      'docker',
      'kici:os:linux',
      'kici:arch:x64',
      'kici:role:builder',
    ]);
    expect(result.userLabels).toEqual(['linux', 'docker']);
    expect(result.autoLabels).toEqual(['kici:os:linux', 'kici:arch:x64', 'kici:role:builder']);
  });

  it('handles all user labels', () => {
    const result = separateLabels(['linux', 'docker']);
    expect(result.userLabels).toEqual(['linux', 'docker']);
    expect(result.autoLabels).toEqual([]);
  });

  it('handles all auto labels', () => {
    const result = separateLabels(['kici:os:linux', 'kici:arch:x64']);
    expect(result.userLabels).toEqual([]);
    expect(result.autoLabels).toEqual(['kici:os:linux', 'kici:arch:x64']);
  });

  it('handles empty array', () => {
    const result = separateLabels([]);
    expect(result.userLabels).toEqual([]);
    expect(result.autoLabels).toEqual([]);
  });
});

describe('scalerAgentLabels', () => {
  it('combines the base label set with the scaler-injected kici: labels', () => {
    const labels = scalerAgentLabels(['linux', 'container'], 'container', 'container-default', [
      'builder',
    ]);
    expect(labels).toEqual([
      'linux',
      'container',
      'kici:agent:container',
      'kici:scaler:container-default',
      'kici:role:builder',
    ]);
  });

  it('expands undefined roles to all known roles (matches the agent wire labels)', () => {
    const labels = scalerAgentLabels(['linux', 'bare-metal'], 'bare-metal', 'bm', undefined);
    expect(labels).toContain('kici:role:builder');
    expect(labels).toContain('kici:role:init-runner');
    expect(labels).toEqual([
      'linux',
      'bare-metal',
      'kici:agent:bare-metal',
      'kici:scaler:bm',
      'kici:role:builder',
      'kici:role:init-runner',
    ]);
  });

  it('emits no role labels for an execution-only scaler ([] roles)', () => {
    const labels = scalerAgentLabels(['linux'], 'container', 'c', []);
    expect(labels).toEqual(['linux', 'kici:agent:container', 'kici:scaler:c']);
  });
});

describe('isSelfReportedLabel', () => {
  it('treats agent platform facts (os/arch/host) as self-reported', () => {
    expect(isSelfReportedLabel('kici:os:linux')).toBe(true);
    expect(isSelfReportedLabel('kici:arch:x64')).toBe(true);
    expect(isSelfReportedLabel('kici:host:abc123')).toBe(true);
  });

  it('does NOT treat scaler-assigned labels (role/agent/scaler) as self-reported', () => {
    // These are authorization-bearing and must be bound by the token.
    expect(isSelfReportedLabel('kici:role:builder')).toBe(false);
    expect(isSelfReportedLabel('kici:agent:container')).toBe(false);
    expect(isSelfReportedLabel('kici:scaler:x')).toBe(false);
  });

  it('does NOT treat user labels as self-reported', () => {
    expect(isSelfReportedLabel('linux')).toBe(false);
    expect(isSelfReportedLabel('container')).toBe(false);
  });
});
