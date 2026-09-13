import { describe, it, expect } from 'vitest';
import {
  checkBackupFreshness,
  resolveStalenessThresholdHours,
  DEFAULT_BACKUP_STALENESS_WARN_HOURS,
} from './backup.js';
import type { DiagnosticDeps } from '../types.js';

/**
 * db stub: `backup_runs` MAX(created_at) query returns `latest`; the
 * `org_settings` MIN(backup_staleness_warn_hours) query returns `minThreshold`.
 * We route by the table name passed to selectFrom.
 */
function stubDb(latest: Date | null, minThreshold: number | null): DiagnosticDeps['db'] {
  return {
    selectFrom: (table: string) => {
      if (table === 'backup_runs') {
        return {
          select: () => ({
            orderBy: () => ({
              limit: () => ({
                executeTakeFirst: async () => (latest ? { created_at: latest } : undefined),
              }),
            }),
          }),
        };
      }
      // org_settings MIN(...) query
      return {
        select: () => ({ executeTakeFirst: async () => ({ min: minThreshold }) }),
      };
    },
  } as unknown as DiagnosticDeps['db'];
}

describe('resolveStalenessThresholdHours', () => {
  it('uses the strictest per-org override when present', async () => {
    const t = await resolveStalenessThresholdHours({
      config: { backupStalenessWarnHours: 24 },
      db: stubDb(null, 6),
    } as DiagnosticDeps);
    expect(t).toBe(6);
  });
  it('falls back to the config default when no override is set', async () => {
    const t = await resolveStalenessThresholdHours({
      config: { backupStalenessWarnHours: 48 },
      db: stubDb(null, null),
    } as DiagnosticDeps);
    expect(t).toBe(48);
  });
  it('falls back to the const default when config is absent', async () => {
    const t = await resolveStalenessThresholdHours({
      config: {},
      db: stubDb(null, null),
    } as DiagnosticDeps);
    expect(t).toBe(DEFAULT_BACKUP_STALENESS_WARN_HOURS);
  });
});

describe('checkBackupFreshness', () => {
  it('fails when no db is configured', async () => {
    const r = await checkBackupFreshness({ config: {} } as DiagnosticDeps);
    expect(r.status).toBe('fail');
  });
  it('fails when no backup has ever been recorded', async () => {
    const r = await checkBackupFreshness({ config: {}, db: stubDb(null, null) } as DiagnosticDeps);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/ever been recorded/i);
  });
  it('passes when the newest backup is within the threshold', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const r = await checkBackupFreshness({
      config: { backupStalenessWarnHours: 24 },
      db: stubDb(recent, null),
    } as DiagnosticDeps);
    expect(r.status).toBe('pass');
  });
  it('warns when the newest backup exceeds the strictest override', async () => {
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h ago
    const r = await checkBackupFreshness({
      config: { backupStalenessWarnHours: 24 },
      db: stubDb(stale, 6),
    } as DiagnosticDeps);
    expect(r.status).toBe('warn'); // 7h > strictest 6h override
  });
});
