import { describe, it, expect } from 'vitest';
import type { Job } from '@kici-dev/sdk';
import { normalizeInitItems } from './directives.js';

function jobWith(init: Job['init']): Job {
  return { _tag: 'Job', name: 'j', runsOn: 'linux', steps: [], init } as unknown as Job;
}

describe('normalizeInitItems', () => {
  it('returns [] for undefined and false', () => {
    expect(normalizeInitItems(jobWith(undefined))).toEqual([]);
    expect(normalizeInitItems(jobWith(false))).toEqual([]);
    expect(normalizeInitItems(undefined)).toEqual([]);
  });

  it("maps 'auto' to a single auto directive", () => {
    expect(normalizeInitItems(jobWith('auto'))).toEqual([{ kind: 'auto' }]);
  });

  it("maps 'mise' to a preset directive with empty config", () => {
    expect(normalizeInitItems(jobWith('mise'))).toEqual([
      { kind: 'preset', name: 'mise', config: {} },
    ]);
  });

  it('maps { mise: cfg } to a preset directive carrying the config', () => {
    expect(normalizeInitItems(jobWith({ mise: { timeout: 5 } }))).toEqual([
      { kind: 'preset', name: 'mise', config: { timeout: 5 } },
    ]);
  });

  it('maps a generic config to a generic directive (passthrough)', () => {
    const cfg = { run: 'echo hi' };
    expect(normalizeInitItems(jobWith(cfg))).toEqual([{ kind: 'generic', config: cfg }]);
  });

  it('maps a mixed array in order', () => {
    const cfg = { run: 'echo hi' };
    expect(normalizeInitItems(jobWith(['mise', cfg]))).toEqual([
      { kind: 'preset', name: 'mise', config: {} },
      { kind: 'generic', config: cfg },
    ]);
  });

  it("throws when 'auto' appears inside an array", () => {
    expect(() => normalizeInitItems(jobWith(['mise', 'auto'] as never))).toThrow(/auto/);
  });
});
