/**
 * Backup-freshness diagnostic check.
 *
 * Reads the newest `backup_runs.created_at` and reports whether the
 * orchestrator DB has a recent `kici-admin db backup`. FAIL when none was ever
 * recorded, WARN when the newest is older than the effective staleness
 * threshold, else PASS.
 *
 * The threshold is cluster-configurable: the strictest (minimum) non-null
 * `org_settings.backup_staleness_warn_hours` across all orgs, falling back to
 * `config.backupStalenessWarnHours` when no org sets an override. A stale
 * whole-DB backup affects every org, so the tightest org requirement wins.
 */
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

export const DEFAULT_BACKUP_STALENESS_WARN_HOURS = 24;

export async function resolveStalenessThresholdHours(deps: DiagnosticDeps): Promise<number> {
  const configDefault =
    typeof deps.config?.backupStalenessWarnHours === 'number'
      ? (deps.config.backupStalenessWarnHours as number)
      : DEFAULT_BACKUP_STALENESS_WARN_HOURS;
  if (!deps.db) return configDefault;
  const row = await deps.db
    .selectFrom('org_settings')
    .select((eb) => eb.fn.min('backup_staleness_warn_hours').as('min'))
    .executeTakeFirst();
  const min = (row as { min: number | null } | undefined)?.min;
  return min != null ? Number(min) : configDefault;
}

export async function checkBackupFreshness(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();
  const name = 'DB backup freshness';

  if (!deps.db) {
    return {
      name,
      status: 'fail',
      message: 'Database not configured',
      durationMs: Date.now() - start,
    };
  }

  try {
    const thresholdHours = await resolveStalenessThresholdHours(deps);
    const row = await deps.db
      .selectFrom('backup_runs')
      .select('created_at')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!row) {
      return {
        name,
        status: 'fail',
        message: 'No orchestrator DB backup has ever been recorded — run `kici-admin db backup`',
        durationMs: Date.now() - start,
      };
    }

    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const ageHours = ageMs / (60 * 60 * 1000);
    const ageLabel = ageHours < 1 ? `${Math.round(ageMs / 60000)}m` : `${ageHours.toFixed(1)}h`;
    const details = {
      lastBackupAt: new Date(row.created_at).toISOString(),
      ageHours,
      thresholdHours,
    };

    if (ageHours > thresholdHours) {
      return {
        name,
        status: 'warn',
        message: `Last backup was ${ageLabel} ago (> ${thresholdHours}h)`,
        details,
        durationMs: Date.now() - start,
      };
    }
    return {
      name,
      status: 'pass',
      message: `Last backup ${ageLabel} ago`,
      details,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `Backup-freshness check error: ${toErrorMessage(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
