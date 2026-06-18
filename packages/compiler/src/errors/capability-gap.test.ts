import { describe, it, expect } from 'vitest';
import { CapabilityGapError, formatCapabilityGapError } from './capability-gap.js';

/**
 * Strip picocolors ANSI escapes so assertions can inspect the raw string
 * (picocolors emits codes even in tests when it detects a TTY parent).
 */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('formatCapabilityGapError', () => {
  it('includes feature, CLI version, and orchestrator version when known', () => {
    const out = stripAnsi(
      formatCapabilityGapError({
        feature: 'log-streaming',
        cliVersion: '0.5.0',
        orchestratorVersion: '0.3.0',
      }),
    );

    expect(out).toContain('log-streaming');
    expect(out).toContain('CLI version:          0.5.0');
    expect(out).toContain('Orchestrator version: 0.3.0');
    expect(out).toContain('Upgrade the orchestrator');
    expect(out).toContain('kici-admin version');
  });

  it('marks orchestrator version as unknown when the probe failed', () => {
    const out = stripAnsi(
      formatCapabilityGapError({
        feature: 'log-streaming',
        cliVersion: '0.5.0',
      }),
    );

    expect(out).toContain('Orchestrator version: unknown');
    expect(out).toContain('capabilities endpoint unreachable');
  });

  it('honours a custom guidance override', () => {
    const out = stripAnsi(
      formatCapabilityGapError({
        feature: 'workflow-caching',
        cliVersion: '0.5.0',
        orchestratorVersion: '0.4.0',
        guidance: 'Ask your operator to enable the workflow-caching feature flag.',
      }),
    );

    expect(out).toContain('Ask your operator to enable');
    expect(out).not.toContain('Run `kici-admin version`');
  });
});

describe('CapabilityGapError', () => {
  it('carries the info payload and sets a useful message', () => {
    const err = new CapabilityGapError({
      feature: 'log-streaming',
      cliVersion: '0.5.0',
      orchestratorVersion: '0.3.0',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CapabilityGapError');
    expect(err.message).toBe('Feature not supported: log-streaming');
    expect(err.info.feature).toBe('log-streaming');
    expect(err.info.cliVersion).toBe('0.5.0');
    expect(err.info.orchestratorVersion).toBe('0.3.0');
  });
});
