import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform-detect to control isRoot() in tests.
vi.mock('./platform-detect.js', () => ({
  isRoot: vi.fn(() => false),
}));

import { isRoot } from './platform-detect.js';
import { resolveUserLevel } from './privilege.js';

const mockedIsRoot = isRoot as ReturnType<typeof vi.fn>;

describe('resolveUserLevel', () => {
  beforeEach(() => {
    mockedIsRoot.mockReset();
  });

  it('auto-detects user-level when running as non-root + no flags', () => {
    mockedIsRoot.mockReturnValue(false);
    expect(resolveUserLevel({})).toBe(true);
  });

  it('auto-detects system-level when running as root + no flags', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({})).toBe(false);
  });

  it('honors --user-level even when running as root', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({ userLevel: true })).toBe(true);
  });

  it('honors --system when running as root', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({ system: true })).toBe(false);
  });

  it('throws when --system is passed but the process is non-root', () => {
    mockedIsRoot.mockReturnValue(false);
    expect(() => resolveUserLevel({ system: true })).toThrow(/requires root/i);
  });

  it('throws when both --system and --user-level are passed', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(() => resolveUserLevel({ system: true, userLevel: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});
