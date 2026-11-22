import { CLIENT_VERSION_HEADER } from '@kici-dev/engine';
import { DashboardApiErrorCode } from '@kici-dev/engine/protocol/dashboard-api-errors';
import { ClientNewerThanPlatformError } from './client-newer-error.js';

export { ClientNewerThanPlatformError };

declare const KICI_VERSION: string;

/** The release this CLI was built from (the same value `kici --version` prints). */
export const CLI_RELEASE_VERSION = typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1';

/** The shape of {@link platformFetch}; tests pass their own. */
export type PlatformFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The caller's headers plus {@link CLIENT_VERSION_HEADER}, in the shape the caller gave them. */
function withClientVersion(headers: HeadersInit | undefined): HeadersInit {
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set(CLIENT_VERSION_HEADER, CLI_RELEASE_VERSION);
    return copy;
  }
  if (Array.isArray(headers)) return [...headers, [CLIENT_VERSION_HEADER, CLI_RELEASE_VERSION]];
  return { ...headers, [CLIENT_VERSION_HEADER]: CLI_RELEASE_VERSION };
}

/** The Platform's message when a 409 is its newer-client refusal, otherwise null. */
async function newerClientRefusal(res: Response): Promise<string | null> {
  if (res.status !== 409) return null;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const { error, message } = (body ?? {}) as { error?: unknown; message?: unknown };
  return error === DashboardApiErrorCode.enum.client_newer_than_platform &&
    typeof message === 'string'
    ? message
    : null;
}

/**
 * `fetch` for a Platform URL: adds {@link CLIENT_VERSION_HEADER} to the caller's headers, and
 * throws {@link ClientNewerThanPlatformError} with the Platform's message when the Platform
 * refuses a CLI newer than itself. Every other response, any other 409 included, is returned.
 */
export async function platformFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: withClientVersion(init.headers) });
  const refusal = await newerClientRefusal(res);
  // fails-when: the refusal reaches the caller as a bare 409, so the user never sees the message
  if (refusal !== null) throw new ClientNewerThanPlatformError(refusal);
  return res;
}
