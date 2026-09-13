import { describe, expect, it } from 'vitest';
import {
  RETENTION_WARN_ROW_THRESHOLD,
  checkRunHistoryRetention,
  retentionVerdict,
} from './retention.js';
import type { DiagnosticDeps } from '../types.js';

const NOW = new Date('2026-09-04T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const ON = {
  runRetentionDays: 90,
  auditRetentionDays: 365,
  provenanceRetentionDays: 365,
  heldRunRetentionDays: 90,
};
const OFF = {
  runRetentionDays: 0,
  auditRetentionDays: 0,
  provenanceRetentionDays: 0,
  heldRunRetentionDays: 0,
};

describe('retentionVerdict — nothing is deleting', () => {
  it('warns when every window is off, no cold store, and the table is large', () => {
    const v = retentionVerdict({
      windows: OFF,
      coldStoreEnabled: false,
      rows: RETENTION_WARN_ROW_THRESHOLD + 1,
      announcedAt: null,
      now: NOW,
    });
    expect(v.status).toBe('warn');
    expect(v.message).toContain('nothing is removing');
    expect(v.message).toContain('KICI_RUN_RETENTION_DAYS');
  });

  it('stays quiet when the table is still small', () => {
    const v = retentionVerdict({
      windows: OFF,
      coldStoreEnabled: false,
      rows: 10,
      announcedAt: null,
      now: NOW,
    });
    expect(v.status).toBe('pass');
  });

  it('does not warn when the cold store is doing the deleting', () => {
    const v = retentionVerdict({
      windows: OFF,
      coldStoreEnabled: true,
      rows: RETENTION_WARN_ROW_THRESHOLD * 10,
      announcedAt: null,
      now: NOW,
    });
    expect(v.status).toBe('pass');
    expect(v.message).toContain('cold store owns');
  });
});

describe('retentionVerdict — retention is on', () => {
  it('names every effective window', () => {
    const v = retentionVerdict({
      windows: ON,
      coldStoreEnabled: false,
      rows: 0,
      announcedAt: null,
      now: NOW,
    });
    expect(v.status).toBe('pass');
    expect(v.message).toContain('runs 90d');
    expect(v.message).toContain('audit 365d');
    expect(v.message).toContain('provenance 365d');
    expect(v.message).toContain('held-runs 90d');
  });

  it('says deletion has not started before the first sweep announces it', () => {
    const v = retentionVerdict({
      windows: ON,
      coldStoreEnabled: false,
      rows: 0,
      announcedAt: null,
      now: NOW,
    });
    expect(v.message).toContain('Deletion starts');
  });

  it('reports the due date while the announce window runs', () => {
    const v = retentionVerdict({
      windows: ON,
      coldStoreEnabled: false,
      rows: 0,
      announcedAt: daysAgo(2),
      now: NOW,
    });
    expect(v.message).toContain('First deletion due 2026-09-09');
  });

  it('reports deletion active once the announce window has elapsed', () => {
    const v = retentionVerdict({
      windows: ON,
      coldStoreEnabled: false,
      rows: 0,
      announcedAt: daysAgo(30),
      now: NOW,
    });
    expect(v.message).toContain('Deletion is active');
  });

  it('says the cold store owns its tables when both tiers are on', () => {
    const v = retentionVerdict({
      windows: ON,
      coldStoreEnabled: true,
      rows: 0,
      announcedAt: daysAgo(30),
      now: NOW,
    });
    expect(v.message).toContain('cold store owns');
    expect(v.message).toContain('covers the rest');
  });
});

describe('checkRunHistoryRetention', () => {
  it('warns rather than throwing when there is no database', async () => {
    const r = await checkRunHistoryRetention({ config: {} } as DiagnosticDeps);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('No database connection');
  });

  it('warns rather than throwing when a query fails', async () => {
    const db = {
      selectFrom: () => {
        throw new Error('connection reset');
      },
    } as unknown as DiagnosticDeps['db'];
    const r = await checkRunHistoryRetention({
      db,
      config: { runRetentionDays: 90 },
    } as DiagnosticDeps);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('connection reset');
  });
});
