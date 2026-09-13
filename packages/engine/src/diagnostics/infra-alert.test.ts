import { describe, it, expect } from 'vitest';
import {
  INFRA_ALERT_TYPES,
  InfraAlertSeverity,
  InfraAlertType,
  normalizeInfraAlertSeverity,
  type InfraAlertSeverity as InfraAlertSeverityType,
  type InfraAlertType as InfraAlertTypeType,
} from './infra-alert.js';
import {
  diagnosticsInfraAlertSchema,
  diagnosticsInfrastructureResponseSchema,
} from '../protocol/messages/dashboard.js';

describe('infrastructure alert vocabulary', () => {
  it('names every alert type the Platform mints', () => {
    expect([...INFRA_ALERT_TYPES]).toEqual([
      'zero-agents',
      'capacity',
      'label-gaps',
      'no-raft-leader',
    ]);
  });

  it('names both severities the Platform mints', () => {
    expect(InfraAlertSeverity.options).toEqual(['warning', 'critical']);
  });

  // Typed `Record<InfraAlertType, true>`: adding a member to the enum without
  // extending this table fails `pnpm typecheck` rather than silently leaving a
  // new alert type unaccounted for.
  it('has an exhaustive table over every alert type', () => {
    const covered: Record<InfraAlertTypeType, true> = {
      [InfraAlertType.enum['zero-agents']]: true,
      [InfraAlertType.enum.capacity]: true,
      [InfraAlertType.enum['label-gaps']]: true,
      [InfraAlertType.enum['no-raft-leader']]: true,
    };
    expect(Object.keys(covered).sort()).toEqual([...INFRA_ALERT_TYPES].sort());
  });

  it('has an exhaustive table over every severity', () => {
    const covered: Record<InfraAlertSeverityType, true> = {
      [InfraAlertSeverity.enum.warning]: true,
      [InfraAlertSeverity.enum.critical]: true,
    };
    expect(Object.keys(covered).sort()).toEqual([...InfraAlertSeverity.options].sort());
  });
});

describe('normalizeInfraAlertSeverity', () => {
  it('passes every known severity through unchanged', () => {
    for (const severity of InfraAlertSeverity.options) {
      expect(normalizeInfraAlertSeverity(severity)).toBe(severity);
    }
  });

  it('escalates a misspelled severity instead of downgrading it to a warning', () => {
    expect(normalizeInfraAlertSeverity('critcal')).toBe(InfraAlertSeverity.enum.critical);
  });

  it('escalates a severity a newer Platform introduced', () => {
    expect(normalizeInfraAlertSeverity('emergency')).toBe(InfraAlertSeverity.enum.critical);
  });

  it('does not resolve a prototype-chain key to an inherited value', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      // Asserting the escalated severity, not merely "some known severity":
      // a body that downgraded every unrecognised key to `warning` would still
      // return a member of the vocabulary and slip past a membership check.
      expect(normalizeInfraAlertSeverity(key)).toBe(InfraAlertSeverity.enum.critical);
    }
  });
});

describe('the infrastructure alert wire schema stays permissive', () => {
  // The `kici` CLI hard-parses this response against the always-latest hosted
  // Platform while pinned to whatever version the customer installed. A strict
  // enum here would fail the whole parse — not one row — the day a new alert
  // type ships, breaking `kici diagnostics` exactly when something is wrong.
  it('accepts an alert type this build does not know', () => {
    const parsed = diagnosticsInfraAlertSchema.safeParse({
      type: 'quorum-degraded',
      message: 'A future alert type',
      severity: InfraAlertSeverity.enum.critical,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an alert severity this build does not know', () => {
    const parsed = diagnosticsInfraAlertSchema.safeParse({
      type: InfraAlertType.enum.capacity,
      message: 'Scaler capacity at 95%',
      severity: 'emergency',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a whole infrastructure response carrying an unknown alert', () => {
    const parsed = diagnosticsInfrastructureResponseSchema.safeParse({
      orchestrators: [],
      alerts: [{ type: 'quorum-degraded', message: 'A future alert', severity: 'emergency' }],
      latestVersion: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts every alert the Platform mints today', () => {
    for (const type of INFRA_ALERT_TYPES) {
      for (const severity of InfraAlertSeverity.options) {
        const parsed = diagnosticsInfraAlertSchema.safeParse({
          type,
          message: 'minted',
          severity,
        });
        expect(parsed.success).toBe(true);
      }
    }
  });
});
