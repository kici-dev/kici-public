/**
 * Platform attach helpers for the local dev plane, with no plane side effects.
 * The minted `kici_ok_` key is what the plane presents on WS auth when it boots
 * hybrid. It is org-scoped and created under the user's own `api_keys:write`
 * permission via their PAT, so attach never mints anything the user could not
 * mint from the dashboard.
 */

import { toErrorMessage } from '@kici-dev/core';

/** http(s) → ws(s), with exactly one trailing `/ws` segment (idempotent). */
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

  const trimmed = url.pathname.replace(/\/+$/, '');
  url.pathname = trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export interface MintedOrchestratorKey {
  /** Raw key, present once. NEVER log this. */
  key: string;
  /** Platform api_keys id, for revoke. */
  keyId: string;
  keyPrefix: string;
}

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
 * Never throws: a failed revoke on detach (offline, expired PAT) is non-fatal,
 * since the local plane stops presenting the key regardless.
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
 * True on any HTTP response, even a 401/404 on `/health`: it proves the
 * network path. A timeout or network error is false.
 */
export async function probePlatformReachable(apiBase: string, timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${apiBase.replace(/\/+$/, '')}/health`;
    const res = await fetch(url, { signal: controller.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Non-sensitive label for the minted key name. */
function orgHostLabel(): string {
  return process.env.HOSTNAME || 'kici-local';
}
