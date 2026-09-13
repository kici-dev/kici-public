/**
 * GitHub App webhook-delivery replay.
 *
 * GitHub keeps every App webhook delivery for a retention window and can be
 * asked to send one again. That is the only way to recover a window of events
 * an orchestrator never received — GitHub itself does not retry a delivery its
 * destination failed to accept, so a window lost while the destination was
 * unreachable is gone unless somebody replays it.
 *
 * Both endpoints are App-level and accept only a JWT signed with the App
 * private key, which the orchestrator holds and nothing upstream does:
 *
 *   GET  /app/hook/deliveries                       (cursor-paginated)
 *   POST /app/hook/deliveries/{delivery_id}/attempts
 *
 * Verified against docs.github.com/en/rest/apps/webhooks on 2026-09-03.
 */

import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import { createAppOctokit, type GitHubAppConfig } from './auth.js';

/** How many deliveries one page request asks GitHub for (the endpoint's max). */
const DELIVERIES_PER_PAGE = 100;

/**
 * Safety ceiling on pages walked in one replay. GitHub returns deliveries
 * newest-first, so the walk normally stops as soon as it passes `since`; this
 * bounds a pathological case (a very old `since` on a very busy App) instead of
 * paginating an App's whole retention window.
 */
export const MAX_DELIVERY_PAGES = 100;

/** What happened to one delivery in a replay. */
export const RedeliverOutcome = z.enum(['redelivered', 'would-redeliver', 'failed']);
export type RedeliverOutcome = z.infer<typeof RedeliverOutcome>;

/** One delivery as `GET /app/hook/deliveries` returns it (the fields used here). */
export interface GithubWebhookDelivery {
  id: number;
  guid: string;
  /** ISO-8601 timestamp GitHub attempted the delivery. */
  delivered_at: string;
  redelivery: boolean;
  event: string;
  action: string | null;
  status: string;
  status_code: number;
  installation_id: number | null;
  repository_id: number | null;
}

/** Per-delivery result of a replay. */
export interface RedeliverResult {
  deliveryId: number;
  guid: string;
  deliveredAt: string;
  event: string;
  action: string | null;
  /** The original delivery's HTTP status as GitHub recorded it. */
  originalStatusCode: number;
  outcome: RedeliverOutcome;
  /** Present when `outcome` is `failed`. */
  error?: string;
}

/** The whole replay, as the admin route and the CLI report it. */
export interface RedeliverWindowResult {
  since: string;
  until: string;
  dryRun: boolean;
  /** Deliveries GitHub holds whose `delivered_at` falls in the window. */
  matched: number;
  /**
   * True when the page walk hit its ceiling before reaching a delivery older
   * than `since`, so `matched` counts only what was gathered and the window
   * holds more. Callers must say so rather than reporting a partial replay as
   * a complete one.
   */
  truncated: boolean;
  redelivered: number;
  failed: number;
  results: RedeliverResult[];
}

/** The one Octokit method this module needs, so a test can hand in a stub. */
export type GithubRequest = Pick<Octokit, 'request'>;

export interface RedeliverWindowOptions {
  /** Inclusive lower bound on `delivered_at`. */
  since: Date;
  /** Exclusive upper bound on `delivered_at`. */
  until: Date;
  /** List and report the matching deliveries without asking GitHub to resend. */
  dryRun?: boolean;
  /** Injected for tests; defaults to a JWT-authenticated App client. */
  octokit?: GithubRequest;
}

/** Read the `cursor` query value out of the `Link: <...>; rel="next"` header. */
export function nextCursorFromLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    if (!/rel="next"/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    const cursor = new URL(url).searchParams.get('cursor');
    if (cursor) return cursor;
  }
  return null;
}

/**
 * Walk `GET /app/hook/deliveries` newest-first and return every delivery whose
 * `delivered_at` falls in `[since, until)`.
 *
 * The walk stops at the first page whose oldest delivery predates `since`:
 * GitHub orders the feed newest-first, so nothing older can match afterwards.
 */
export async function listDeliveriesInWindow(
  octokit: GithubRequest,
  opts: { since: Date; until: Date },
): Promise<{ deliveries: GithubWebhookDelivery[]; truncated: boolean }> {
  const sinceMs = opts.since.getTime();
  const untilMs = opts.until.getTime();
  const matched: GithubWebhookDelivery[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_DELIVERY_PAGES; page++) {
    const response = await octokit.request('GET /app/hook/deliveries', {
      per_page: DELIVERIES_PER_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    const deliveries = (response.data ?? []) as GithubWebhookDelivery[];
    if (deliveries.length === 0) return { deliveries: matched, truncated: false };

    let reachedOlderThanSince = false;
    for (const delivery of deliveries) {
      const at = Date.parse(delivery.delivered_at);
      if (Number.isNaN(at)) continue;
      if (at < sinceMs) {
        reachedOlderThanSince = true;
        continue;
      }
      if (at >= untilMs) continue;
      matched.push(delivery);
    }
    if (reachedOlderThanSince) return { deliveries: matched, truncated: false };

    cursor = nextCursorFromLink(
      (response.headers as Record<string, string | undefined> | undefined)?.link,
    );
    if (!cursor) return { deliveries: matched, truncated: false };
  }
  // The ceiling was reached with pages still to walk: the window genuinely
  // holds more than we gathered.
  return { deliveries: matched, truncated: true };
}

/** Ask GitHub to send one delivery again. Resolves once GitHub accepts (202). */
export async function redeliverDelivery(octokit: GithubRequest, deliveryId: number): Promise<void> {
  await octokit.request('POST /app/hook/deliveries/{delivery_id}/attempts', {
    delivery_id: deliveryId,
  });
}

/**
 * Replay every delivery GitHub holds for this App in `[since, until)`.
 *
 * A per-delivery failure is recorded and the replay continues: an operator
 * recovering an outage window wants the deliveries that can be replayed, plus
 * an honest list of the ones that could not.
 */
export async function redeliverWindow(
  app: GitHubAppConfig,
  opts: RedeliverWindowOptions,
): Promise<RedeliverWindowResult> {
  const octokit = opts.octokit ?? createAppOctokit(app);
  const dryRun = opts.dryRun === true;
  const { deliveries, truncated } = await listDeliveriesInWindow(octokit, {
    since: opts.since,
    until: opts.until,
  });

  const results: RedeliverResult[] = [];
  let redelivered = 0;
  let failed = 0;

  for (const delivery of deliveries) {
    const base = {
      deliveryId: delivery.id,
      guid: delivery.guid,
      deliveredAt: delivery.delivered_at,
      event: delivery.event,
      action: delivery.action ?? null,
      originalStatusCode: delivery.status_code,
    };
    if (dryRun) {
      results.push({ ...base, outcome: RedeliverOutcome.enum['would-redeliver'] });
      continue;
    }
    try {
      await redeliverDelivery(octokit, delivery.id);
      redelivered++;
      results.push({ ...base, outcome: RedeliverOutcome.enum.redelivered });
    } catch (err) {
      failed++;
      results.push({
        ...base,
        outcome: RedeliverOutcome.enum.failed,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    since: opts.since.toISOString(),
    until: opts.until.toISOString(),
    dryRun,
    matched: deliveries.length,
    truncated,
    redelivered,
    failed,
    results,
  };
}
