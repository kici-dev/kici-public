/**
 * How `kici report` treats the CLI's own config file. The shared `redactConfig`
 * allowlist knows only orchestrator config, so it masks every CLI field. Most
 * are credentials or personal data and stay masked; the few that name which
 * Platform and organization the CLI used stay readable, since a "Run not found"
 * bundle is unreadable without them.
 */

import { redactConfig } from '@kici-dev/core/diagnostics-redaction';
import { DashboardClientError } from '../../remote/dashboard-client.js';

/**
 * Top-level fields kept readable: each is a location or a timestamp, never a
 * credential. The PAT, its id, the legacy token, the routing key, the user's
 * email and the per-org cluster map stay masked.
 */
export const REPORT_READABLE_CONFIG_KEYS = [
  'platformEndpoint',
  'endpoint',
  'oidcIssuer',
  'activeOrgId',
  'patExpiresAt',
] as const;

/**
 * The shared allowlist first, then the readable fields restored at the top
 * level only. The bundle writer's free-text scrubber still masks a credential
 * embedded in an endpoint URL.
 */
export function redactCliConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactConfig(config) as Record<string, unknown>;
  for (const key of REPORT_READABLE_CONFIG_KEYS) {
    const value = config[key];
    if (typeof value === 'string') redacted[key] = value;
  }
  // The direct orchestrator's URL is a location; its token stays masked.
  const direct = config.direct as { url?: unknown } | undefined;
  if (typeof direct?.url === 'string') {
    redacted.direct = { ...(redacted.direct as Record<string, unknown>), url: direct.url };
  }
  return redacted;
}

export interface LookupTarget {
  endpoint: string;
  orgId: string;
}

function stringField(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Matches `DashboardClient.fromConfig`: `platformEndpoint` minus one trailing
 * slash, scoped to `activeOrgId`. Undefined when either is missing; the fetch
 * then fails with its own "not logged in" or "no active organization" message.
 */
export function lookupTarget(
  config: Record<string, unknown> | undefined,
): LookupTarget | undefined {
  if (!config) return undefined;
  const endpoint = stringField(config, 'platformEndpoint');
  const orgId = stringField(config, 'activeOrgId');
  if (!endpoint || !orgId) return undefined;
  return { endpoint: endpoint.replace(/\/$/, ''), orgId };
}

/**
 * Names the searched Platform and organization on a not-found error, so a
 * bundle tells a lookup in the wrong place from a missing run. Other errors
 * pass through unchanged.
 */
export function withLookupTarget(err: unknown, target: LookupTarget | undefined): unknown {
  if (!target || !(err instanceof DashboardClientError) || err.kind !== 'not_found') return err;
  return new DashboardClientError(
    err.kind,
    `${err.message} (searched org ${target.orgId} on ${target.endpoint})`,
    err.status,
  );
}
