/**
 * The three things an upgrade has to do before it stops the service.
 *
 * Each one existed as a capability the upgrade never called:
 *
 *   - **Drain.** The drain flag, the admin route, the CLI verb and a tested
 *     `waitForQuiesce` poller were all already here, and the upgrade went
 *     straight from "extracted" to `manager.stop()`. Every in-flight job died
 *     with the restart, and on an autoscaling cluster the shutdown tears the
 *     scaler down first, so scaler-managed agents die with their jobs.
 *   - **Backup.** `kici-admin db backup` existed and nothing scheduled it; the
 *     upgrade never took one. `checkBackupFreshness` has been reporting FAIL
 *     since install for a backup the product gave no way to produce.
 *   - **Schema guard.** Rolling back flips a symlink. The previous release's
 *     static migration provider does not carry the newer migrations' names, so
 *     Kysely throws `corrupted migrations` on boot and systemd restarts it
 *     forever — the documented recovery produces a second outage.
 *
 * All three are orchestrator-only. An agent has no database and no drain.
 */
import { toErrorMessage } from '@kici-dev/shared';

/** The drain snapshot both the CLI verb and this module poll. */
export interface DrainSnapshot {
  draining: boolean;
  jobsRunning: number;
}

export interface WaitOpts {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until no jobs are running, or the deadline passes.
 *
 * Extracted so the upgrade and `kici-admin orchestrator drain --wait` share one
 * implementation rather than two that can disagree about what quiesced means.
 */
export async function waitForQuiesce(
  poll: () => Promise<DrainSnapshot>,
  opts: WaitOpts,
): Promise<{ quiesced: boolean; jobsRunning: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const snap = await poll();
    if (snap.jobsRunning === 0) return { quiesced: true, jobsRunning: 0 };
    if (now() >= deadline) return { quiesced: false, jobsRunning: snap.jobsRunning };
    await sleep(opts.intervalMs);
  }
}

/** One entry of `GET /api/v1/admin/db/migrate/status`. */
export interface MigrationStatusRow {
  name: string;
  status: string;
}

/**
 * The last applied migration reported by a running service.
 *
 * Returns null when nothing has been applied — a fresh database — which the
 * caller must not confuse with "could not read it".
 */
export function appliedHead(rows: readonly MigrationStatusRow[]): string | null {
  const applied = rows.filter((r) => r.status === 'applied');
  return applied.length === 0 ? null : (applied[applied.length - 1]!.name ?? null);
}

/** Migrations applied after `head`, in ledger order. */
export function migrationsAfter(rows: readonly MigrationStatusRow[], head: string): string[] {
  const applied = rows.filter((r) => r.status === 'applied').map((r) => r.name);
  const idx = applied.indexOf(head);
  return idx === -1 ? [] : applied.slice(idx + 1);
}

export type SchemaGuardVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown-head'; message: string }
  | { kind: 'ahead'; extra: string[]; message: string };

/**
 * Decide whether the version pointer may move.
 *
 * Three outcomes, and the middle one is the compatibility shim: an instance
 * installed before `migrationHeads` existed has no recorded head, and refusing
 * there would break the documented `--rollback` on exactly the installs that
 * predate the guard. So an unknown head warns loudly and falls through to the
 * existing confirmation prompt; the map is populated at the next version
 * change, arming the guard one upgrade later.
 */
export function schemaGuardVerdict(input: {
  targetVersion: string;
  recordedHead: string | null | undefined;
  liveRows: readonly MigrationStatusRow[];
}): SchemaGuardVerdict {
  const { targetVersion, recordedHead, liveRows } = input;
  if (!recordedHead) {
    return {
      kind: 'unknown-head',
      message:
        `WARNING: no migration head is recorded for ${targetVersion}.\n` +
        `  This instance was installed before the schema guard existed, so it cannot be\n` +
        `  checked whether the database is ahead of that version. If it is, the older\n` +
        `  binary will refuse to boot with "corrupted migrations" and restart in a loop.\n` +
        `  Take a dump first ("kici-admin db backup"). If the switch does loop, start the\n` +
        `  older version with KICI_AUTO_MIGRATE=false — it boots only if every newer\n` +
        `  migration was purely additive.\n` +
        `  The head is recorded from this version change on, so the guard is armed for\n` +
        `  the next one.`,
    };
  }

  const live = appliedHead(liveRows);
  if (live === null || live === recordedHead) return { kind: 'ok' };

  const extra = migrationsAfter(liveRows, recordedHead);
  if (extra.length === 0) return { kind: 'ok' };

  return {
    kind: 'ahead',
    extra,
    message:
      `Error: the database schema is ahead of ${targetVersion}.\n` +
      `  ${targetVersion} was last running at "${recordedHead}"; ${extra.length} migration(s) ` +
      `have been applied since:\n` +
      extra.map((n) => `    - ${n}`).join('\n') +
      `\n\n  ${targetVersion} does not carry those migrations, so it would refuse to boot with\n` +
      `  "corrupted migrations" and restart in a loop.\n\n` +
      `  Take a dump first:\n` +
      `    kici-admin db backup\n\n` +
      `  Then either revert the schema and re-run:\n` +
      `    kici-admin db migrate --to ${recordedHead}\n` +
      `  or let the upgrade do it:\n` +
      `    kici-admin orchestrator upgrade --rollback --migrate-down`,
  };
}

/** Merge one version's head into the manifest map, never replacing it. */
export function mergeMigrationHead(
  existing: Record<string, string> | undefined,
  version: string,
  head: string | null,
): Record<string, string> | undefined {
  if (head === null) return existing;
  return { ...(existing ?? {}), [version]: head };
}

/** Read the live applied head, returning null when the service cannot answer. */
export async function readLiveMigrationRows(
  fetchStatus: () => Promise<{ migrations: MigrationStatusRow[] }>,
): Promise<MigrationStatusRow[] | null> {
  try {
    return (await fetchStatus()).migrations;
  } catch {
    // A service that is not running, or an admin API that is unreachable, is
    // not evidence about the schema. The caller treats null as "cannot tell".
    return null;
  }
}

/** Format the reason a pre-upgrade backup could not be taken. */
export function backupRefusalMessage(reason: string): string {
  return (
    `Error: the pre-upgrade backup could not be taken.\n` +
    `  ${reason}\n\n` +
    `  An upgrade without a dump has no recovery path if it goes wrong. Fix the cause,\n` +
    `  or re-run with --skip-backup to proceed without one.`
  );
}

/**
 * Format the drain-timeout refusal.
 *
 * The refusal leaves the coordinator draining — deliberately, so the in-flight
 * jobs finish without new ones piling up behind them. But a drained
 * coordinator accepts nothing, so the message has to say so and name the way
 * back; an operator who reads only "wait and re-run" does not know their CI is
 * stalled meanwhile.
 */
export function drainTimeoutMessage(jobsRunning: number, timeoutSeconds: number): string {
  return (
    `Error: ${jobsRunning} job(s) were still running after ${timeoutSeconds}s of draining.\n` +
    `  Restarting now would fail every one of them.\n\n` +
    `  Wait for them to finish and re-run, raise the window with --drain-timeout <seconds>,\n` +
    `  or accept the loss with --no-drain.\n\n` +
    `  The coordinator is LEFT DRAINING so those jobs can finish undisturbed — it accepts\n` +
    `  no new work until the upgrade restarts it, or until you run:\n` +
    `    kici-admin orchestrator resume`
  );
}

/** Describe a failure to reach the admin API during the pre-stop phase. */
export function adminApiUnavailable(action: string, err: unknown): string {
  return `${action} could not be performed: ${toErrorMessage(err)}`;
}
