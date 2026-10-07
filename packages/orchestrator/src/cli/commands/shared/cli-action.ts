import { toErrorMessage } from '@kici-dev/shared';

/** Commander option flag and help text shared by every command that can bypass HTTP. */
export const DIRECT_DB_URL_FLAG = '--database-url <url>';
export const DIRECT_DB_URL_HELP = 'Use direct DB access instead of HTTP (offline mode)';

/** `--database-url`, else `KICI_DATABASE_URL`, else null (null = use the HTTP admin API). */
export function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

/** Like {@link resolveDirectDbUrl} but required: throws when neither source is set. */
export function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
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

/**
 * Wrap a Commander action so any thrown error prints `Error: <message>` to
 * stderr and exits 1.
 */
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
