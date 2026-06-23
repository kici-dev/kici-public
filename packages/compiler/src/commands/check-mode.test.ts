import { describe, it, expect } from 'vitest';
import { CheckMode } from '@kici-dev/engine';
import { resolveCheckMode } from './check-mode.js';

describe('resolveCheckMode', () => {
  it('returns apply when no flags are set', () => {
    expect(resolveCheckMode({})).toBe(CheckMode.enum.apply);
    expect(resolveCheckMode({ check: false, failOnDrift: false })).toBe(CheckMode.enum.apply);
  });

  it('returns check when --check is set', () => {
    expect(resolveCheckMode({ check: true })).toBe(CheckMode.enum.check);
  });

  it('returns check-fail-on-drift when both --check and --fail-on-drift are set', () => {
    expect(resolveCheckMode({ check: true, failOnDrift: true })).toBe(
      CheckMode.enum['check-fail-on-drift'],
    );
  });

  it('throws when --fail-on-drift is set without --check', () => {
    expect(() => resolveCheckMode({ failOnDrift: true })).toThrow(
      '--fail-on-drift requires --check',
    );
  });
});
