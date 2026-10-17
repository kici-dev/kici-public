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

  it('refuses an object preset this agent does not know, naming its keys', () => {
    // fails-when: an unknown { nix } item falls through as a generic config with no run
    expect(() => normalizeInitItems(jobWith({ nix: { packages: ['hello'] } } as never))).toThrow(
      /init\[0\]: unknown init item \{ nix \}.*upgrade the agent/,
    );
  });

  it('refuses an unknown preset string', () => {
    expect(() => normalizeInitItems(jobWith(['mise', 'nix'] as never))).toThrow(
      /init\[1\]: unknown init item 'nix'/,
    );
  });

  it('maps { apt } to an apt preset directive', () => {
    // fails-when: the agent refuses the apt preset as an unknown item
    expect(normalizeInitItems(jobWith({ apt: { packages: ['make'] } }))).toEqual([
      { kind: 'preset', name: 'apt', config: { packages: ['make'] } },
    ]);
  });

  it('still accepts a generic config with extra fields', () => {
    // breaks-if-wrong: a valid { run } spec is refused
    const cfg = { run: 'echo hi', env: { A: '1' }, timeout: 5 };
    expect(normalizeInitItems(jobWith(cfg))).toEqual([{ kind: 'generic', config: cfg }]);
  });
});
