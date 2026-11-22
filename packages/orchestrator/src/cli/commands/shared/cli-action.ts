import { toErrorMessage } from '@kici-dev/shared';

/** Commander option flag and help text shared by every command that can bypass HTTP. */
export const DIRECT_DB_URL_FLAG = '--database-url <url>';
export const DIRECT_DB_URL_HELP = 'Use direct DB access instead of HTTP (offline mode)';

/** Whether the running command line names the admin API with the global `--url`. */
let adminUrlOnCommandLine = false;

/**
 * Record whether the global `--url` came from the command line. The kici-admin
 * program sets it before every action.
 */
export function setAdminUrlOnCommandLine(value: boolean): void {
  adminUrlOnCommandLine = value;
}

/**
 * `--database-url`, else null when the command line names the admin API with
 * `--url`, else `KICI_DATABASE_URL`, else null (null = use the HTTP admin API).
 * An explicit `--url` wins over `KICI_DATABASE_URL`, which the environment of
 * an orchestrator host often carries for the orchestrator itself.
 */
export function resolveDirectDbUrl(explicit?: string): string | null {
  if (explicit !== undefined) return explicit;
  // fails-when: KICI_DATABASE_URL in the environment silently overrides an explicit --url
  if (adminUrlOnCommandLine) return null;
  return process.env.KICI_DATABASE_URL ?? null;
}

/**
 * For a command with no admin-API mode: `--database-url`, else
 * `KICI_DATABASE_URL`, else null. The global `--url` does not change the
 * result, because there is no admin API call to select.
 */
export function resolveDbOnlyUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

/**
 * {@link resolveDbOnlyUrl} for a direct-DB-only command: prints the refusal and
 * exits 1 when neither source is set.
 */
export function requireDbOnlyUrl(explicit?: string): string {
  const url = resolveDbOnlyUrl(explicit);
  if (url) return url;
  console.error('Error: --database-url or KICI_DATABASE_URL is required (direct-DB only)');
  process.exit(1);
}

/** Like {@link resolveDbOnlyUrl} but required: throws when neither source is set. */
export function resolveDatabaseUrl(explicit?: string): string {
  const url = resolveDbOnlyUrl(explicit);
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

/** Parse an optional integer flag; throws naming the flag on a non-integer. */
export function parseIntOption(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${label}: must be an integer (got "${raw}")`);
  }
  return n;
}

/** A thrown error prints `Error: <message>` to stderr and exits 1. */
export function cliAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  };
}

/** Print `value` as one JSON line when `json` is set, otherwise hand it to `render`. */
export function printJsonOr<T>(json: boolean | undefined, value: T, render: (v: T) => void): void {
  if (json) console.log(JSON.stringify(value));
  else render(value);
}
