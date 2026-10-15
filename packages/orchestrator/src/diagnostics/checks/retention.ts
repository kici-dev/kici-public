/**
 * Run-history retention check: is anything removing rows from this database? An operator cannot
 * otherwise ask, and with no deleter the only symptom is a disk filling months later.
 *
 * WARN when every window is disabled AND the cold store is off AND `execution_runs` is past the
 * threshold — no deleter, and a table large enough to matter. Otherwise PASS, naming the
 * effective windows and, while the announce window runs, the date the first deletion is due.
 */
import { sql } from 'kysely';
import { toErrorMessage } from '@kici-dev/shared';
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { readOrchestratorColdStoreConfig } from '../../cold-store/orchestrator-cold-store.js';
import {
  RETENTION_ANNOUNCE_DAYS,
  allWindowsDisabled,
  resolveRetentionWindows,
  type RetentionWindows,
} from '../../queue/retention.js';

/** Rows past which an unbounded `execution_runs` is worth warning about. */
export const RETENTION_WARN_ROW_THRESHOLD = 500_000;

function windowsFromConfig(config: Record<string, unknown>): RetentionWindows {
  const num = (key: string, fallback: number): number =>
    typeof config[key] === 'number' ? (config[key] as number) : fallback;
  return {
    runRetentionDays: num('runRetentionDays', 90),
    auditRetentionDays: num('auditRetentionDays', 365),
    provenanceRetentionDays: num('provenanceRetentionDays', 365),
    heldRunRetentionDays: num('heldRunRetentionDays', 90),
  };
}

function describe(w: RetentionWindows): string {
  return (
    `runs ${w.runRetentionDays}d, audit ${w.auditRetentionDays}d, ` +
    `provenance ${w.provenanceRetentionDays}d, held-runs ${w.heldRunRetentionDays}d`
  );
}

/** Gathered by the check, decided by `retentionVerdict`. */
export interface RetentionVerdictInput {
  windows: RetentionWindows;
  coldStoreEnabled: boolean;
  /** `execution_runs` row count. Only read when every window is disabled. */
  rows: number;
  announcedAt: Date | null;
  now: Date;
  rowThreshold?: number;
}

/**
 * Split from the check so branches are testable without a database — notably WARN, which needs
 * a row count larger than any fixture would seed.
 */
export function retentionVerdict(
  input: RetentionVerdictInput,
): Pick<DiagnosticResult, 'status' | 'message' | 'details'> {
  const { windows, coldStoreEnabled, rows, announcedAt, now } = input;
  const threshold = input.rowThreshold ?? RETENTION_WARN_ROW_THRESHOLD;
  const details = { windows, coldStoreEnabled, announcedAt };

  if (allWindowsDisabled(windows) && !coldStoreEnabled) {
    if (rows > threshold) {
      return {
        status: 'warn',
        message:
          `Every retention window is disabled, no object store is configured, and ` +
          `execution_runs holds ${rows.toLocaleString()} rows — nothing is removing ` +
          `history. Set KICI_RUN_RETENTION_DAYS (or ` +
          `"kici-admin cluster-settings set --run-retention-days <n>") to bound it.`,
        details: { ...details, rows },
      };
    }
    return {
      status: 'pass',
      message: `Retention is disabled; execution_runs holds ${rows.toLocaleString()} rows.`,
      details: { ...details, rows },
    };
  }

  let message = `Effective windows: ${describe(windows)}.`;
  if (coldStoreEnabled) {
    message += ' The cold store owns the tables it archives; this tier covers the rest.';
  }
  if (announcedAt === null) {
    message += ` Deletion starts ${RETENTION_ANNOUNCE_DAYS} days after the first sweep announces it.`;
  } else {
    const due = new Date(
      new Date(announcedAt).getTime() + RETENTION_ANNOUNCE_DAYS * 24 * 60 * 60 * 1000,
    );
    message +=
      due.getTime() > now.getTime()
        ? ` First deletion due ${due.toISOString().slice(0, 10)}.`
        : ' Deletion is active.';
  }
  return { status: 'pass', message, details };
}

export async function checkRunHistoryRetention(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();
  const name = 'Run history retention';

  if (!deps.db) {
    return {
      name,
      status: 'warn',
      message: 'No database connection; retention could not be checked.',
      durationMs: Date.now() - start,
    };
  }

  try {
    const windows = await resolveRetentionWindows(
      windowsFromConfig(deps.config),
      deps.clusterSettings,
    );
    const coldStoreEnabled = readOrchestratorColdStoreConfig().enabled;

    // Only meaningful with no deleter, and the one large-table scan here — so it runs only then.
    let rows = 0;
    if (allWindowsDisabled(windows) && !coldStoreEnabled) {
      const r = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM public.execution_runs
      `.execute(deps.db);
      rows = Number(r.rows[0]?.n ?? 0);
    }

    const settings = await deps.db
      .selectFrom('cluster_settings')
      .select('retention_announced_at')
      .where('id', '=', 'default')
      .executeTakeFirst();

    return {
      name,
      ...retentionVerdict({
        windows,
        coldStoreEnabled,
        rows,
        announcedAt: settings?.retention_announced_at ?? null,
        now: new Date(),
      }),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `Retention could not be checked: ${toErrorMessage(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
