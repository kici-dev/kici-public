import { describe, expect, it, vi } from 'vitest';
import {
  appliedHead,
  backupRefusalMessage,
  drainTimeoutMessage,
  mergeMigrationHead,
  migrationsAfter,
  readLiveMigrationRows,
  schemaGuardVerdict,
  waitForQuiesce,
  type MigrationStatusRow,
} from './upgrade-safety.js';

const rows = (...spec: Array<[string, string]>): MigrationStatusRow[] =>
  spec.map(([name, status]) => ({ name, status }));

const LEDGER = rows(
  ['130_a', 'applied'],
  ['131_b', 'applied'],
  ['132_c', 'applied'],
  ['133_d', 'pending'],
);

describe('appliedHead', () => {
  it('is the last applied migration', () => {
    expect(appliedHead(LEDGER)).toBe('132_c');
  });

  it('is null on a fresh database', () => {
    expect(appliedHead(rows(['130_a', 'pending']))).toBeNull();
  });
});

describe('migrationsAfter', () => {
  it('lists only what was applied after the head', () => {
    expect(migrationsAfter(LEDGER, '130_a')).toEqual(['131_b', '132_c']);
  });

  it('is empty when the head is already the last applied one', () => {
    expect(migrationsAfter(LEDGER, '132_c')).toEqual([]);
  });

  it('is empty when the head is not in the ledger at all', () => {
    expect(migrationsAfter(LEDGER, '999_gone')).toEqual([]);
  });
});

describe('schemaGuardVerdict', () => {
  it('proceeds when the heads match', () => {
    expect(
      schemaGuardVerdict({ targetVersion: '0.20.1', recordedHead: '132_c', liveRows: LEDGER }),
    ).toEqual({ kind: 'ok' });
  });

  it('proceeds against a fresh database, which cannot be ahead of anything', () => {
    expect(
      schemaGuardVerdict({
        targetVersion: '0.20.1',
        recordedHead: '132_c',
        liveRows: rows(['130_a', 'pending']),
      }).kind,
    ).toBe('ok');
  });

  it('refuses when the database is ahead, naming every extra migration', () => {
    const v = schemaGuardVerdict({
      targetVersion: '0.20.1',
      recordedHead: '130_a',
      liveRows: LEDGER,
    });
    expect(v.kind).toBe('ahead');
    if (v.kind !== 'ahead') throw new Error('unreachable');
    expect(v.extra).toEqual(['131_b', '132_c']);
    expect(v.message).toContain('131_b');
    expect(v.message).toContain('132_c');
    // The refusal has to be actionable: a dump, and the two ways forward.
    expect(v.message).toContain('kici-admin db backup');
    expect(v.message).toContain('kici-admin db migrate --to 130_a');
    expect(v.message).toContain('--migrate-down');
  });

  it('warns, rather than refusing, when no head was ever recorded', () => {
    // Every instance installed before the guard existed lands here. Refusing
    // would break the documented --rollback on exactly those installs.
    const v = schemaGuardVerdict({
      targetVersion: '0.19.0',
      recordedHead: undefined,
      liveRows: LEDGER,
    });
    expect(v.kind).toBe('unknown-head');
    if (v.kind !== 'unknown-head') throw new Error('unreachable');
    expect(v.message).toContain('WARNING');
    expect(v.message).toContain('KICI_AUTO_MIGRATE=false');
    expect(v.message).toContain('kici-admin db backup');
  });
});

describe('mergeMigrationHead', () => {
  it('adds a version without disturbing the others', () => {
    expect(mergeMigrationHead({ '0.19.0': '120_x' }, '0.20.0', '132_c')).toEqual({
      '0.19.0': '120_x',
      '0.20.0': '132_c',
    });
  });

  it('creates the map when there was none', () => {
    expect(mergeMigrationHead(undefined, '0.20.0', '132_c')).toEqual({ '0.20.0': '132_c' });
  });

  it('records nothing for a fresh database rather than writing a null', () => {
    expect(mergeMigrationHead({ '0.19.0': '120_x' }, '0.20.0', null)).toEqual({
      '0.19.0': '120_x',
    });
  });
});

describe('readLiveMigrationRows', () => {
  it('returns the ledger', async () => {
    expect(await readLiveMigrationRows(async () => ({ migrations: LEDGER }))).toEqual(LEDGER);
  });

  it('returns null when the service cannot answer, never an empty ledger', async () => {
    // An empty ledger would read as "fresh database, nothing to be ahead of",
    // which is exactly the wrong conclusion from an unreachable service.
    expect(
      await readLiveMigrationRows(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).toBeNull();
  });
});

describe('waitForQuiesce', () => {
  it('returns immediately when nothing is running', async () => {
    const poll = vi.fn().mockResolvedValue({ draining: true, jobsRunning: 0 });
    expect(await waitForQuiesce(poll, { timeoutMs: 1000, intervalMs: 10 })).toEqual({
      quiesced: true,
      jobsRunning: 0,
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('polls until the jobs drain', async () => {
    const snaps = [
      { draining: true, jobsRunning: 2 },
      { draining: true, jobsRunning: 1 },
      { draining: true, jobsRunning: 0 },
    ];
    const poll = vi.fn(async () => snaps.shift()!);
    const res = await waitForQuiesce(poll, {
      timeoutMs: 10_000,
      intervalMs: 10,
      sleep: async () => {},
    });
    expect(res.quiesced).toBe(true);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('gives up at the deadline, reporting what is still running', async () => {
    let t = 0;
    const res = await waitForQuiesce(async () => ({ draining: true, jobsRunning: 3 }), {
      timeoutMs: 50,
      intervalMs: 10,
      now: () => (t += 40),
      sleep: async () => {},
    });
    expect(res).toEqual({ quiesced: false, jobsRunning: 3 });
  });
});

describe('refusal messages', () => {
  it('names the cause and the opt-out for a failed backup', () => {
    const m = backupRefusalMessage('pg_dump not found on PATH');
    expect(m).toContain('pg_dump not found on PATH');
    expect(m).toContain('--skip-backup');
  });

  it('names the still-running count and every way forward on a drain timeout', () => {
    const m = drainTimeoutMessage(4, 300);
    expect(m).toContain('4 job(s)');
    expect(m).toContain('300s');
    expect(m).toContain('--drain-timeout');
    expect(m).toContain('--no-drain');
    // The refusal leaves the coordinator draining, so it has to name the
    // verb that undoes that — a stalled cluster is otherwise silent.
    expect(m).toContain('kici-admin orchestrator resume');
  });
});
