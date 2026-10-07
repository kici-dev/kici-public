/**
 * How `kici report` treats the CLI's own config file.
 *
 * The shared `redactConfig` allowlist knows orchestrator config, not the CLI's
 * fields, so on its own it masks all of them. Most are credentials or personal
 * data and stay masked. A few say only where the CLI looks — which Platform,
 * which organization — and a "Run not found" bundle cannot be read without
 * them: a CLI logged in to one Platform or organization cannot see a run on
 * another, and only these fields show which one it used.
 */

import { redactConfig } from '@kici-dev/core/diagnostics-redaction';
import { DashboardClientError } from '../../remote/dashboard-client.js';

/**
 * Top-level CLI config fields kept readable in a redacted bundle. Each is a
 * location or a timestamp, never a credential. The PAT, its id, the legacy
 * token, the routing key, the user's email and the per-org cluster map stay
 * masked.
 */
export const REPORT_READABLE_CONFIG_KEYS = [
  'platformEndpoint',
  'endpoint',
  'oidcIssuer',
  'activeOrgId',
  'patExpiresAt',
] as const;

/**
 * Redact the CLI config for a bundle: the shared allowlist first, then the
 * readable location fields restored at the top level only. The bundle writer
 * still runs the free-text scrubber over the result, so a credential embedded
 * in an endpoint URL is masked there.
 */
export function redactCliConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactConfig(config) as Record<string, unknown>;
  for (const key of REPORT_READABLE_CONFIG_KEYS) {
    const value = config[key];
    if (typeof value === 'string') redacted[key] = value;
  }
  return redacted;
}

/** The Platform and organization a dashboard request goes to. */
export interface LookupTarget {
  endpoint: string;
  orgId: string;
}

function stringField(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve the lookup target the same way `DashboardClient.fromConfig` does:
 * `platformEndpoint`, with one trailing slash stripped, scoped to `activeOrgId`. Undefined when either half is missing —
 * the fetch then fails with its own "not logged in" or "no active
 * organization" message, which needs no target.
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
 * Name the searched Platform and organization on a not-found error, so a
 * bundle can tell a lookup in the wrong place from a run that does not exist.
 * Every other error passes through unchanged.
 */
export function withLookupTarget(err: unknown, target: LookupTarget | undefined): unknown {
  if (!target || !(err instanceof DashboardClientError) || err.kind !== 'not_found') return err;
  return new DashboardClientError(
    err.kind,
    `${err.message} (searched org ${target.orgId} on ${target.endpoint})`,
    err.status,
  );
}
