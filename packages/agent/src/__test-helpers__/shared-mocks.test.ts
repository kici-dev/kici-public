import './shared-mocks.js';
import { createLogger, sha256 } from '@kici-dev/shared';
import { describe, expect, it, vi } from 'vitest';

describe('shared-mocks', () => {
  it('silences the logger and keeps the real exports', () => {
    // fails-when: the vi.mock call is not hoisted here (e.g. it moves into the
    // pre-built test-support package), so createLogger is the real one.
    expect(vi.isMockFunction(createLogger().info)).toBe(true);
    expect(sha256('x')).toHaveLength(64);
  });
});
