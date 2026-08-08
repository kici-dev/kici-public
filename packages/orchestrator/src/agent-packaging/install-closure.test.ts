import { describe, it, expect, afterEach } from 'vitest';
import { agentInstallSpec } from './install-closure.js';

describe('agentInstallSpec', () => {
  const original = process.env.KICI_DEV;
  afterEach(() => {
    if (original === undefined) delete process.env.KICI_DEV;
    else process.env.KICI_DEV = original;
  });

  it('pins the exact published version in production', () => {
    delete process.env.KICI_DEV;
    expect(agentInstallSpec('0.2.0')).toBe('@kici-dev/agent@0.2.0');
  });

  it('matches the base version prereleases in dev mode', () => {
    process.env.KICI_DEV = 'true';
    expect(agentInstallSpec('0.2.0')).toBe('@kici-dev/agent@^0.2.0-0');
  });
});
