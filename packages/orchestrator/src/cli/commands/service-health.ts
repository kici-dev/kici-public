/**
 * Reads a locally installed KiCI service's health endpoints and formats what
 * they report. `kici-admin orchestrator status` and `kici-admin agent status`
 * both render through here, so the two sections agree on layout and on how a
 * missing field is handled.
 */

import fs from 'node:fs';
import { formatUptime, type BuildFingerprint, type LivenessBase } from '@kici-dev/shared';
import { readEnvValue } from '../service/backup-timer.js';

/** How long a health request waits unless the caller passes its own timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

/** Hex digits of a bundle hash to show: the length the build prints in its `deps:` line. */
const SHORT_HASH_LENGTH = 12;

/** Bind addresses that mean "every interface", reached on `localhost`. */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/** A label and its value: one line of a status section. */
export type StatusRow = readonly [label: string, value: string];

/**
 * Read the env file, or empty content when it is missing or unreadable. A file
 * this account may not read is reported: the port and address the caller then
 * falls back to may not be the ones the service uses. On Windows only
 * LocalSystem and Administrators can read a service's env file.
 */
export function readEnvContent(
  envFilePath: string,
  warn: (line: string) => void = console.warn,
): string {
  try {
    // No existence check first: in a folder this account may not open, the
    // check reports the file as missing, and only the read names the reason.
    return fs.readFileSync(envFilePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      warn(
        `Warning: cannot read ${envFilePath} (${code}), so the default port and address are used. ` +
          `Run the command as an administrator, or as an account that can read the file.`,
      );
    }
    return '';
  }
}

/** Where a service installed on this host answers HTTP. */
export interface LocalEndpoint {
  host: string;
  port: number;
  /** The prefix the service's routes are mounted under; empty when they sit at `/`. */
  pathPrefix: string;
}

/**
 * Where the service answers, read from its env file: `KICI_PORT` (or
 * `defaultPort`), `KICI_HOST` and `KICI_BASE_PATH`. A service bound to every
 * interface is reached on `localhost`; one bound to a single address is reached
 * there. The agent reads none of the last two, so its env file never sets them.
 */
export function readLocalEndpoint(envContent: string, defaultPort: number): LocalEndpoint {
  const portValue = readEnvValue(envContent, 'KICI_PORT');
  const port = portValue === undefined ? NaN : parseInt(portValue, 10);
  const bindHost = readEnvValue(envContent, 'KICI_HOST')?.trim() ?? '';
  const basePath = readEnvValue(envContent, 'KICI_BASE_PATH')?.trim() ?? '';
  const trimmedPath = basePath.replace(/^\/+|\/+$/g, '');
  return {
    host: WILDCARD_HOSTS.has(bindHost) ? 'localhost' : bindHost,
    port: isNaN(port) ? defaultPort : port,
    pathPrefix: trimmedPath === '' ? '' : `/${trimmedPath}`,
  };
}

/** The URL of `pathname` on `endpoint`, with an IPv6 host bracketed. */
export function localUrl(endpoint: LocalEndpoint, pathname: string): string {
  const host =
    endpoint.host.includes(':') && !endpoint.host.startsWith('[')
      ? `[${endpoint.host}]`
      : endpoint.host;
  return `http://${host}:${endpoint.port}${endpoint.pathPrefix}${pathname}`;
}

/** What a local JSON request got: a body, a refusing status, or no answer at all. */
export type LocalJsonResult<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'http-error'; status: number }
  | { kind: 'no-answer' };

/**
 * GET a JSON body from a service on this host. `acceptStatuses` names the
 * non-2xx codes whose body is still an answer; `headers` carries credentials.
 */
export async function requestLocalJson<T>(
  endpoint: LocalEndpoint,
  pathname: string,
  opts: {
    acceptStatuses?: readonly number[];
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<LocalJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const res = await fetch(localUrl(endpoint, pathname), {
      signal: controller.signal,
      ...(opts.headers && { headers: opts.headers }),
    });
    if (!res.ok && !(opts.acceptStatuses ?? []).includes(res.status)) {
      return { kind: 'http-error', status: res.status };
    }
    return { kind: 'ok', status: res.status, body: (await res.json()) as T };
  } catch {
    return { kind: 'no-answer' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET a JSON body from a service on this host. `acceptStatuses` names the
 * non-2xx codes whose body is still an answer: `/ready` returns its checks
 * with a 503 when one fails. Returns null when nothing answers in time.
 */
export async function fetchLocalJson<T>(
  endpoint: LocalEndpoint,
  pathname: string,
  opts: { acceptStatuses?: readonly number[]; timeoutMs?: number } = {},
): Promise<T | null> {
  const result = await requestLocalJson<T>(endpoint, pathname, opts);
  return result.kind === 'ok' ? result.body : null;
}

/**
 * Rows for the build fingerprint and process uptime of a `/health` body. A
 * field the body lacks is skipped, so a service older than this CLI renders
 * the fields it does report.
 */
export function buildInfoRows(
  health: Partial<LivenessBase & BuildFingerprint & { buildDate: string }>,
): StatusRow[] {
  const rows: StatusRow[] = [];
  if (health.version) {
    rows.push([
      'Version',
      health.buildDate ? `${health.version} (built ${health.buildDate})` : health.version,
    ]);
  }
  if (health.sdkVersion) {
    rows.push([
      'SDK',
      health.sdkBundleHash
        ? `${health.sdkVersion} (bundle ${health.sdkBundleHash.slice(0, SHORT_HASH_LENGTH)})`
        : health.sdkVersion,
    ]);
  }
  if (typeof health.uptime === 'number') {
    // `/health` reports fractional seconds; the formatter expects whole ones.
    rows.push(['Uptime', formatUptime(Math.floor(health.uptime))]);
  }
  return rows;
}

/**
 * A status section: a blank separator line, the heading, then one line per
 * row with each value starting at `valueColumn`. A body with no field this CLI
 * recognises still gets a line saying so, so the heading never stands alone.
 */
export function formatHealthSection(
  heading: string,
  rows: readonly StatusRow[],
  valueColumn: number,
): string[] {
  const shown: readonly StatusRow[] =
    rows.length > 0 ? rows : [['Health', 'answered, with no fields this CLI recognises']];
  return ['', heading, ...shown.map(([label, value]) => `${label}:`.padEnd(valueColumn) + value)];
}
