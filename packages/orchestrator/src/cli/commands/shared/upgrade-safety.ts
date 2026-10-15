/**
 * What an orchestrator upgrade does before it stops the service (an agent has
 * no database and no drain):
 *
 *   - **Drain.** A restart kills every in-flight job, and on an autoscaling
 *     cluster the shutdown tears the scaler down first, so scaler-managed
 *     agents die with their jobs.
 *   - **Backup.** The pre-upgrade dump is the recovery path if the upgrade
 *     goes wrong.
 *   - **Schema guard.** A rollback flips a symlink, and the older release's
 *     static migration provider lacks the newer migrations' names, so Kysely
 *     throws `corrupted migrations` on boot and systemd restarts it forever.
 */
import { toErrorMessage } from '@kici-dev/shared';
import { sleep as defaultSleep } from '@kici-dev/engine';

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
 * Poll until no jobs are running, or the deadline passes. The upgrade and
 * `kici-admin orchestrator drain --wait` share it so they agree on what
 * quiesced means.
 */
export async function waitForQuiesce(
  poll: () => Promise<DrainSnapshot>,
  opts: WaitOpts,
): Promise<{ quiesced: boolean; jobsRunning: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const snap = await poll();
    if (snap.jobsRunning === 0) return { quiesced: true, jobsRunning: 0 };
    if (now() >= deadline) return { quiesced: false, jobsRunning: snap.jobsRunning };
    await sleep(opts.intervalMs);
  }
}

/** Printed when a version switch cannot read the live migration ledger. */
export const SCHEMA_NOT_CHECKED =
  'The running service could not be reached, so the schema was not checked.';

/** One entry of `GET /api/v1/admin/db/migrate/status`. */
export interface MigrationStatusRow {
  name: string;
  status: string;
}

/**
 * The last applied migration. Null means a fresh database, which the caller
 * must not confuse with "could not read it".
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
 * Decide whether the version pointer may move. `unknown-head` is a compat
 * shim: an install from before `migrationHeads`, or whose upgrade away from
 * the target ran without admin access, has no recorded head, and refusing
 * would break its documented `--rollback`. It warns and falls through to the
 * confirmation; the next version change with admin access records the head
 * and arms the guard.
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
        `  Either this instance was installed before the schema guard existed, or the\n` +
        `  upgrade away from ${targetVersion} ran without admin access (KICI_ADMIN_TOKEN).\n` +
        `  So it cannot be checked whether the database is ahead of that version. If it\n` +
        `  is, the older binary will refuse to boot with "corrupted migrations" and\n` +
        `  restart in a loop.\n` +
        `  Take a dump first ("kici-admin db backup"). If the switch does loop, start the\n` +
        `  older version with KICI_AUTO_MIGRATE=false — it boots only if every newer\n` +
        `  migration was purely additive.\n` +
        `  A version change with admin access records the head, which arms the guard\n` +
        `  for the next one.`,
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

/**
 * The live migration rows, or null when the service or admin API cannot
 * answer: that is no evidence about the schema, so null means "cannot tell".
 */
export async function readLiveMigrationRows(
  fetchStatus: () => Promise<{ migrations: MigrationStatusRow[] }>,
): Promise<MigrationStatusRow[] | null> {
  try {
    return (await fetchStatus()).migrations;
  } catch {
    return null;
  }
}

export function backupRefusalMessage(reason: string): string {
  return (
    `Error: the pre-upgrade backup could not be taken.\n` +
    `  ${reason}\n\n` +
    `  An upgrade without a dump has no recovery path if it goes wrong. Fix the cause,\n` +
    `  or re-run with --skip-backup to proceed without one.`
  );
}

/**
 * The drain-timeout refusal. It leaves the coordinator draining on purpose so
 * in-flight jobs finish without new ones piling up, and so must say that CI
 * accepts nothing meanwhile and name the way back.
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

/** A failure to reach the admin API during the pre-stop phase. */
export function adminApiUnavailable(action: string, err: unknown): string {
  return `${action} could not be performed: ${toErrorMessage(err)}`;
}
