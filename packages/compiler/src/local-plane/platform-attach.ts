/**
 * Platform attach helpers for the local dev plane. Pure HTTP/URL helpers with no
 * plane side-effects: derive the orchestrator WS relay URL from the CLI's HTTPS
 * API base, mint/revoke an org-scoped orchestrator key via the Platform API
 * using the logged-in personal access token, and probe Platform reachability.
 *
 * The minted key (prefix `kici_ok_`) is what the plane presents on WS auth when
 * it boots hybrid. It is org-scoped and created under the calling user's own
 * `api_keys:write` permission — attach never mints anything the user could not
 * mint from the dashboard.
 */

import { toErrorMessage } from '@kici-dev/core';

/**
 * Derive the orchestrator WS relay URL from the CLI's HTTPS Platform API base.
 * `https://…` → `wss://…`, `http://…` → `ws://…`, then ensure a single trailing
 * `/ws` path segment (idempotent when the base already ends in `/ws`).
 */
export function derivePlatformWsUrl(apiBase: string): string {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error(`Invalid Platform API base URL: ${apiBase}`);
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error(`Platform API base must be http(s): ${apiBase}`);

  // Normalize the path to end in exactly one `/ws` segment.
  const trimmed = url.pathname.replace(/\/+$/, '');
  url.pathname = trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export interface MintedOrchestratorKey {
  /** Raw orchestrator key (kici_ok_…) — present once. NEVER log this. */
  key: string;
  /** Platform api_keys id (for later revoke). */
  keyId: string;
  keyPrefix: string;
}

/**
 * Mint an org-scoped orchestrator key via the Platform HTTP API using the PAT.
 * `POST ${apiBase}/api/v1/orgs/${orgId}/orchestrator-keys`.
 */
export async function mintOrchestratorKey(args: {
  apiBase: string;
  pat: string;
  orgId: string;
  name?: string;
}): Promise<MintedOrchestratorKey> {
  const url = `${args.apiBase.replace(/\/+$/, '')}/api/v1/orgs/${encodeURIComponent(args.orgId)}/orchestrator-keys`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name ?? `local dev plane (${orgHostLabel()})` }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the Platform to mint an orchestrator key: ${toErrorMessage(err)}`,
    );
  }
  if (res.status === 401) {
    throw new Error(
      'Platform rejected the credentials (401). Run `kici login` to re-authenticate.',
    );
  }
  if (res.status === 403) {
    throw new Error(
      `Your account lacks permission to create orchestrator keys in org ${args.orgId} ` +
        '(needs the api_keys:write permission — an Owner can grant it).',
    );
  }
  if (!res.ok) {
    throw new Error(`Platform returned ${res.status} minting the orchestrator key.`);
  }
  const body = (await res.json()) as { key?: string; id?: string; keyPrefix?: string };
  if (!body.key || !body.id) {
    throw new Error('Platform orchestrator-key response was missing the key or id.');
  }
  return { key: body.key, keyId: body.id, keyPrefix: body.keyPrefix ?? 'kici_ok_' };
}

/**
 * Best-effort revoke of a previously-minted orchestrator key on detach.
 * `DELETE ${apiBase}/api/v1/orgs/${orgId}/orchestrator-keys/${keyId}`. Never
 * throws — a failed revoke (offline, expired PAT) is non-fatal; the key is
 * org-scoped and the local plane stops presenting it regardless.
 */
export async function revokeOrchestratorKey(args: {
  apiBase: string;
  pat: string;
  orgId: string;
  keyId: string;
}): Promise<boolean> {
  const url = `${args.apiBase.replace(/\/+$/, '')}/api/v1/orgs/${encodeURIComponent(args.orgId)}/orchestrator-keys/${encodeURIComponent(args.keyId)}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.pat}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Bounded reachability probe against the Platform API base. Returns true when
 * the base responds (any HTTP status — a reachable Platform, even a 401/404 on
 * `/health`, proves the network path). A timeout / network error is false.
 */
export async function probePlatformReachable(apiBase: string, timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${apiBase.replace(/\/+$/, '')}/health`;
    const res = await fetch(url, { signal: controller.signal });
    // Any HTTP response (even 4xx) means the Platform is reachable.
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A short, non-sensitive label for the minted key name (the machine host). */
function orgHostLabel(): string {
  return process.env.HOSTNAME || 'kici-local';
}
