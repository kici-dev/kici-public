/**
 * Shared HTTP plumbing for the `kici approve` / `kici reject` held-run
 * commands. Resolves auth + endpoint from the global config (PAT preferred,
 * API key fallback; Platform endpoint preferred, orchestrator fallback) and
 * exposes thin list / approve / reject helpers against the Platform dashboard
 * API.
 */

import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { loadGlobalConfig } from '../remote/config.js';
import type { HeldRunSummary } from './held-run-resolve.js';

/** Resolved auth context for a held-run command. */
export interface HeldRunContext {
  endpoint: string;
  token: string;
  orgId: string;
}

/**
 * Resolve the auth context, printing a clear error and returning null when the
 * CLI is not authenticated / no active org is set.
 */
export async function resolveHeldRunContext(): Promise<HeldRunContext | null> {
  const config = await loadGlobalConfig();

  const token = config.pat ?? config.token;
  if (!token) {
    logger.error(pc.red('Not authenticated. Run `kici login` to get started.'));
    return null;
  }

  const endpoint = config.platformEndpoint ?? config.endpoint;
  if (!endpoint) {
    logger.error(pc.red('No endpoint configured. Run `kici login` to configure.'));
    return null;
  }

  if (!config.activeOrgId) {
    logger.error(pc.red('No active organization. Run `kici org use <name>` to set one.'));
    return null;
  }

  return { endpoint, token, orgId: config.activeOrgId };
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/** List the held runs for a single run id. */
export async function listHeldRunsForRun(
  ctx: HeldRunContext,
  runId: string,
): Promise<HeldRunSummary[]> {
  const url = `${ctx.endpoint}/api/v1/orgs/${ctx.orgId}/held-runs?runId=${encodeURIComponent(runId)}`;
  const response = await fetch(url, { method: 'GET', headers: authHeaders(ctx.token) });
  if (!response.ok) {
    throw new Error(await describeError(response));
  }
  const data = (await response.json()) as { heldRuns?: HeldRunSummary[] };
  return data.heldRuns ?? [];
}

/**
 * POST an approve decision for a held run. Returns true on success. When
 * `autoApprove` is set, marks the approval as a `kici run --approve-all`
 * breakglass so the orchestrator audits it as `held_run.auto_approve`
 * (eligibility is still enforced server-side — never a bypass).
 */
export async function postApprove(
  ctx: HeldRunContext,
  heldRunId: string,
  autoApprove = false,
): Promise<boolean> {
  const query = autoApprove ? '?auto=1' : '';
  const url = `${ctx.endpoint}/api/v1/orgs/${ctx.orgId}/held-runs/${heldRunId}/approve${query}`;
  const response = await fetch(url, { method: 'POST', headers: authHeaders(ctx.token) });
  if (!response.ok) {
    logger.error(pc.red(await describeError(response)));
    return false;
  }
  return true;
}

/** POST a reject decision (with reason) for a held run. Returns true on success. */
export async function postReject(
  ctx: HeldRunContext,
  heldRunId: string,
  reason: string,
): Promise<boolean> {
  const url = `${ctx.endpoint}/api/v1/orgs/${ctx.orgId}/held-runs/${heldRunId}/reject`;
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(ctx.token),
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    logger.error(pc.red(await describeError(response)));
    return false;
  }
  return true;
}

/** Build a user-facing error string from a failed response. */
async function describeError(response: Response): Promise<string> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: string };
    detail = body.error;
  } catch {
    // Ignore parse errors.
  }
  switch (response.status) {
    case 401:
      return 'Authentication failed. Run `kici login` to re-authenticate.';
    case 403:
      return `Access denied${detail ? `: ${detail}` : ''}.`;
    case 404:
      return `Held run not found${detail ? `: ${detail}` : ''}.`;
    default:
      return detail ?? `Request failed with status ${response.status}.`;
  }
}
