import { describe, it, expect, vi } from 'vitest';
import {
  MAX_DELIVERY_PAGES,
  listDeliveriesInWindow,
  nextCursorFromLink,
  redeliverDelivery,
  redeliverWindow,
  RedeliverOutcome,
  type GithubRequest,
  type GithubWebhookDelivery,
} from './deliveries.js';

const APP = { appId: '42', privateKey: 'pem' };

function delivery(overrides: Partial<GithubWebhookDelivery>): GithubWebhookDelivery {
  return {
    id: 1,
    guid: 'g-1',
    delivered_at: '2026-09-01T12:00:00Z',
    redelivery: false,
    event: 'push',
    action: null,
    status: 'OK',
    status_code: 200,
    installation_id: 9,
    repository_id: 7,
    ...overrides,
  };
}

/**
 * Stub Octokit whose `GET /app/hook/deliveries` serves the given pages in
 * order, threading a `Link: rel="next"` header between them.
 */
function stubOctokit(pages: GithubWebhookDelivery[][], onRedeliver?: (id: number) => void) {
  let page = 0;
  const request = vi.fn(async (route: string, params?: Record<string, unknown>) => {
    if (route === 'GET /app/hook/deliveries') {
      const data = pages[page] ?? [];
      const hasNext = page < pages.length - 1;
      page++;
      return {
        data,
        headers: hasNext
          ? { link: `<https://api.github.com/app/hook/deliveries?cursor=c${page}>; rel="next"` }
          : {},
      };
    }
    if (route === 'POST /app/hook/deliveries/{delivery_id}/attempts') {
      onRedeliver?.(params?.delivery_id as number);
      return { data: {}, headers: {} };
    }
    throw new Error(`unexpected route ${route}`);
  });
  return { octokit: { request } as unknown as GithubRequest, request };
}

describe('nextCursorFromLink', () => {
  it('reads the cursor out of the rel="next" link', () => {
    expect(
      nextCursorFromLink('<https://api.github.com/app/hook/deliveries?cursor=abc>; rel="next"'),
    ).toBe('abc');
  });

  it('ignores a rel="prev" link', () => {
    expect(
      nextCursorFromLink('<https://api.github.com/app/hook/deliveries?cursor=abc>; rel="prev"'),
    ).toBeNull();
  });

  it('picks the next link out of a multi-rel header', () => {
    const link =
      '<https://api.github.com/app/hook/deliveries?cursor=old>; rel="prev", ' +
      '<https://api.github.com/app/hook/deliveries?cursor=new>; rel="next"';
    expect(nextCursorFromLink(link)).toBe('new');
  });

  it('returns null for a missing header', () => {
    expect(nextCursorFromLink(undefined)).toBeNull();
  });
});

describe('listDeliveriesInWindow', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const until = new Date('2026-09-02T00:00:00Z');

  it('keeps deliveries inside the window and drops the ones outside it', async () => {
    const { octokit } = stubOctokit([
      [
        delivery({ id: 3, delivered_at: '2026-09-02T01:00:00Z' }), // after until
        delivery({ id: 2, delivered_at: '2026-09-01T12:00:00Z' }), // inside
        delivery({ id: 1, delivered_at: '2026-08-31T23:00:00Z' }), // before since
      ],
    ]);

    const { deliveries: found } = await listDeliveriesInWindow(octokit, { since, until });

    expect(found.map((d) => d.id)).toEqual([2]);
  });

  it('treats until as exclusive and since as inclusive', async () => {
    const { octokit } = stubOctokit([
      [
        delivery({ id: 2, delivered_at: until.toISOString() }),
        delivery({ id: 1, delivered_at: since.toISOString() }),
      ],
    ]);

    const { deliveries: found } = await listDeliveriesInWindow(octokit, { since, until });

    expect(found.map((d) => d.id)).toEqual([1]);
  });

  it('follows the next cursor across pages', async () => {
    const { octokit, request } = stubOctokit([
      [delivery({ id: 2, delivered_at: '2026-09-01T18:00:00Z' })],
      [delivery({ id: 1, delivered_at: '2026-09-01T06:00:00Z' })],
    ]);

    const { deliveries: found } = await listDeliveriesInWindow(octokit, { since, until });

    expect(found.map((d) => d.id)).toEqual([2, 1]);
    expect(request.mock.calls[1][1]).toMatchObject({ cursor: 'c1' });
  });

  it('stops paginating once a page reaches past since', async () => {
    const { octokit, request } = stubOctokit([
      [
        delivery({ id: 2, delivered_at: '2026-09-01T06:00:00Z' }),
        delivery({ id: 1, delivered_at: '2026-08-30T06:00:00Z' }),
      ],
      [delivery({ id: 0, delivered_at: '2026-08-29T06:00:00Z' })],
    ]);

    const { deliveries: found } = await listDeliveriesInWindow(octokit, { since, until });

    expect(found.map((d) => d.id)).toEqual([2]);
    // The feed is newest-first, so nothing on a later page can match.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page', async () => {
    const { octokit, request } = stubOctokit([[]]);

    expect((await listDeliveriesInWindow(octokit, { since, until })).deliveries).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('skips a delivery with an unparseable timestamp instead of matching it', async () => {
    const { octokit } = stubOctokit([[delivery({ id: 5, delivered_at: 'not-a-date' })]]);

    expect((await listDeliveriesInWindow(octokit, { since, until })).deliveries).toEqual([]);
  });

  it('reports truncated when the page ceiling is reached with more to walk', async () => {
    // Every page is in-window and every page advertises a next cursor, so the
    // walk can only end by exhausting its ceiling. Reporting `truncated: false`
    // here would tell an operator a partial replay covered the whole window.
    const pages = Array.from({ length: MAX_DELIVERY_PAGES + 5 }, (_unused, i) => [
      delivery({ id: i + 1, delivered_at: '2026-09-01T12:00:00Z' }),
    ]);
    const { octokit, request } = stubOctokit(pages);

    const res = await listDeliveriesInWindow(octokit, { since, until });

    expect(res.truncated).toBe(true);
    expect(res.deliveries).toHaveLength(MAX_DELIVERY_PAGES);
    expect(request).toHaveBeenCalledTimes(MAX_DELIVERY_PAGES);
  });

  it('reports truncated=false when the walk ends on its own', async () => {
    // Positive control for the assertion above: the same shape, but the feed
    // runs out before the ceiling.
    const { octokit } = stubOctokit([
      [delivery({ id: 1, delivered_at: '2026-09-01T12:00:00Z' })],
      [delivery({ id: 2, delivered_at: '2026-08-30T12:00:00Z' })], // older than since
    ]);

    const res = await listDeliveriesInWindow(octokit, { since, until });

    expect(res.truncated).toBe(false);
    expect(res.deliveries.map((d) => d.id)).toEqual([1]);
  });
});

describe('redeliverDelivery', () => {
  it('posts an attempt for the delivery id', async () => {
    const seen: number[] = [];
    const { octokit } = stubOctokit([[]], (id) => seen.push(id));

    await redeliverDelivery(octokit, 77);

    expect(seen).toEqual([77]);
  });
});

describe('redeliverWindow', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const until = new Date('2026-09-02T00:00:00Z');

  it('redelivers every matching delivery and tallies the outcome', async () => {
    const seen: number[] = [];
    const { octokit } = stubOctokit(
      [
        [
          delivery({ id: 2, guid: 'g-2', delivered_at: '2026-09-01T18:00:00Z', status_code: 502 }),
          delivery({ id: 1, guid: 'g-1', delivered_at: '2026-09-01T06:00:00Z' }),
        ],
      ],
      (id) => seen.push(id),
    );

    const result = await redeliverWindow(APP, { since, until, octokit });

    expect(seen).toEqual([2, 1]);
    expect(result).toMatchObject({ matched: 2, redelivered: 2, failed: 0, dryRun: false });
    expect(result.results[0]).toMatchObject({
      deliveryId: 2,
      guid: 'g-2',
      originalStatusCode: 502,
      outcome: RedeliverOutcome.enum.redelivered,
    });
  });

  it('a dry run reports what it would send and sends nothing', async () => {
    const seen: number[] = [];
    const { octokit } = stubOctokit(
      [[delivery({ id: 1, delivered_at: '2026-09-01T06:00:00Z' })]],
      (id) => seen.push(id),
    );

    const result = await redeliverWindow(APP, { since, until, dryRun: true, octokit });

    expect(seen).toEqual([]);
    expect(result).toMatchObject({ matched: 1, redelivered: 0, failed: 0, dryRun: true });
    expect(result.results[0].outcome).toBe(RedeliverOutcome.enum['would-redeliver']);
  });

  it('records a per-delivery failure and keeps going', async () => {
    let calls = 0;
    const request = vi.fn(async (route: string) => {
      if (route === 'GET /app/hook/deliveries') {
        return {
          data: [
            delivery({ id: 2, delivered_at: '2026-09-01T18:00:00Z' }),
            delivery({ id: 1, delivered_at: '2026-09-01T06:00:00Z' }),
          ],
          headers: {},
        };
      }
      calls++;
      if (calls === 1) throw new Error('GitHub said no');
      return { data: {}, headers: {} };
    });

    const result = await redeliverWindow(APP, {
      since,
      until,
      octokit: { request } as unknown as GithubRequest,
    });

    expect(result).toMatchObject({ matched: 2, redelivered: 1, failed: 1 });
    expect(result.results[0]).toMatchObject({
      outcome: RedeliverOutcome.enum.failed,
      error: 'GitHub said no',
    });
    expect(result.results[1].outcome).toBe(RedeliverOutcome.enum.redelivered);
  });

  it('echoes the window it replayed', async () => {
    const { octokit } = stubOctokit([[]]);

    const result = await redeliverWindow(APP, { since, until, octokit });

    expect(result.since).toBe(since.toISOString());
    expect(result.until).toBe(until.toISOString());
    expect(result.matched).toBe(0);
  });
});
