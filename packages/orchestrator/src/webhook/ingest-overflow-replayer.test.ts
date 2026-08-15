import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { IngestOverflowReplayer } from './ingest-overflow-replayer.js';
import { OverflowSourceKind, OverflowStatus } from './ingest-overflow-types.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import { resetIngestOverflowMetricState } from '../metrics/prometheus.js';

interface Row {
  id: number;
  delivery_id: string;
  routing_key: string;
  source_kind: string;
  provider: string | null;
  event: string;
  action: string | null;
  body: string;
  meta: Record<string, unknown>;
  captured_at: Date;
  replay_attempts: number;
  status: string;
  last_error: string | null;
  claimed_at: Date | null;
}

/**
 * Fake Kysely covering the replayer's queries:
 *  - selectFrom(...).selectAll().where().orderBy().limit(N).execute() — claim candidates
 *  - selectFrom(...).select(count).where().executeTakeFirstOrThrow() — depth gauge
 *  - updateTable(...).set(patch).where(id).where(status?)...            — claim / status update
 *  - deleteFrom(...).where().execute()                                 — sweep replayed
 */
/**
 * Cutoff the fake's stale-reclaim arm compares against. A test that wants no
 * reclaim leaves it at 0 (nothing is older than the epoch); a test exercising
 * the reclaim raises it.
 */
let staleCutoffMs = 0;

function makeFakeDb(rows: Row[]): Kysely<Database> {
  const buffered = (): Row[] =>
    rows
      .filter((r) => r.status === OverflowStatus.enum.buffered)
      .sort((a, b) => a.captured_at.getTime() - b.captured_at.getTime());
  return {
    selectFrom: () => ({
      // .selectAll() → claim-candidates chain.
      selectAll: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => ({
              execute: async () => buffered().slice(0, n),
            }),
          }),
        }),
      }),
      // .select(...) serves three chains, discriminated by what follows:
      //  - depth gauge:      .where().executeTakeFirstOrThrow()
      //  - stale reclaim:    .where(status).where(cb).limit(n).execute()
      //  - releaseClaim read:.where(id).where(status).executeTakeFirst()
      select: (cols: unknown) => ({
        where: (col?: string, _op?: string, val?: unknown) => ({
          executeTakeFirstOrThrow: async () => ({ count: String(buffered().length) }),
          // Stale-reclaim arm: the second `where` is a callback, not a triple.
          where: (second: unknown, _o2?: string, v2?: unknown) => {
            if (typeof second === 'function') {
              return {
                limit: (n: number) => ({
                  execute: async () =>
                    rows
                      .filter(
                        (r) =>
                          r.status === OverflowStatus.enum.replaying &&
                          (r.claimed_at ?? r.captured_at).getTime() < staleCutoffMs,
                      )
                      .slice(0, n),
                }),
              };
            }
            return {
              executeTakeFirst: async () =>
                rows.find(
                  (r) =>
                    r.id === val &&
                    (r as unknown as Record<string, unknown>)[second as string] === v2,
                ),
            };
          },
        }),
        // Unused chains keep `cols` referenced for the type checker.
        _cols: cols,
      }),
    }),
    updateTable: () => ({
      set: (patch: Partial<Row>) => ({
        where: (_col: string, _op: string, val: unknown) => {
          const apply = (extra?: { col: string; val: unknown }) => ({
            executeTakeFirst: async () => {
              const target = rows.find(
                (r) =>
                  r.id === val &&
                  (!extra || (r as Record<string, unknown>)[extra.col] === extra.val),
              );
              if (!target) return { numUpdatedRows: 0n };
              Object.assign(target, patch);
              return { numUpdatedRows: 1n };
            },
            execute: async () => {
              const target = rows.find((r) => r.id === val);
              if (target) Object.assign(target, patch);
            },
          });
          return {
            where: (c2: string, _o2: string, v2: unknown) => apply({ col: c2, val: v2 }),
            ...apply(),
          };
        },
      }),
    }),
    deleteFrom: () => ({
      where: () => ({
        execute: async () => {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i]!.status === OverflowStatus.enum.replayed) rows.splice(i, 1);
          }
        },
      }),
    }),
  } as unknown as Kysely<Database>;
}

function row(id: number, over: Partial<Row> = {}): Row {
  return {
    id,
    delivery_id: `d-${id}`,
    routing_key: 'github:1',
    source_kind: OverflowSourceKind.enum.direct,
    provider: 'github',
    event: 'push',
    action: null,
    body: Buffer.from('{}').toString('base64'),
    meta: {},
    captured_at: new Date(1000 + id),
    replay_attempts: 0,
    status: OverflowStatus.enum.buffered,
    last_error: null,
    claimed_at: null,
    ...over,
  };
}

const controller = (shedding: boolean) => ({ isShedding: () => shedding });

function makeReplayer(rows: Row[], shedding: boolean, batchSize = 10, maxAttempts = 3) {
  return new IngestOverflowReplayer({
    db: makeFakeDb(rows),
    controller: controller(shedding),
    intervalMs: 1000,
    batchSize,
    maxAttempts,
    claimTimeoutMs: 900_000,
  });
}

describe('IngestOverflowReplayer', () => {
  beforeEach(() => {
    resetIngestOverflowMetricState();
    // Nothing is stale by default; the reclaim tests raise this explicitly.
    staleCutoffMs = 0;
  });

  it('skips the entire pass while the controller is shedding', async () => {
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, true);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(reinject).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
  });

  it('drains oldest-first and marks replayed on success (then sweeps)', async () => {
    const rows = [row(2), row(1)]; // captured_at 1002, 1001
    const seen: string[] = [];
    const reinject = vi.fn(async (d) => {
      seen.push(d.deliveryId);
      return WebhookIngestOutcome.enum.processed;
    });
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(seen).toEqual(['d-1', 'd-2']); // FIFO by captured_at
    expect(rows).toHaveLength(0); // replayed rows swept
  });

  it('reverts to buffered (not lost) and bumps attempts on a re-shed', async () => {
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.shed);
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(1);
  });

  it('marks failed at max attempts', async () => {
    const rows = [row(1, { replay_attempts: 2 })]; // one more → 3 == maxAttempts
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.shed);
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.failed);
    expect(rows[0]!.replay_attempts).toBe(3);
  });

  it('honors the batch size bound', async () => {
    const rows = [row(1), row(2), row(3)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, false, 2);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(reinject).toHaveBeenCalledTimes(2);
  });

  it('a duplicate delivery id replays as duplicate → success, no double dispatch', async () => {
    // processWebhook returns `duplicate` when the dedup claim loses; the replayer
    // treats duplicate/skipped/processed all as terminal success (row removed).
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.duplicate);
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(rows).toHaveLength(0); // swept as replayed
  });
  it('reclaims a claim a dead worker never released, so the delivery is retried', async () => {
    // The whole basis of the accept path's durability claim: an acknowledged
    // delivery whose worker was killed mid-pipeline leaves its row `replaying`
    // with nothing to release it. Without this, the row is stranded forever and
    // "durably queued" means nothing.
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date(1) })];
    staleCutoffMs = 10_000;
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);

    await r.runPass();

    // Reclaimed AND re-injected in the same pass, and the abandoned attempt is
    // counted so a row that keeps stranding eventually goes `failed`.
    expect(reinject).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });

  it('leaves a fresh claim alone', async () => {
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date() })];
    staleCutoffMs = 0; // nothing predates the epoch
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, false);
    r.setReinjectDirect(reinject);

    await r.runPass();

    // Reclaiming a live worker's row would re-run a pipeline still in flight.
    expect(reinject).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.replaying);
  });

  it('reclaims while the controller is shedding, without re-injecting', async () => {
    // A stranded claim is stranded regardless of load. Freeing it under shed is
    // safe because the freed row simply waits in `buffered`.
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date(1) })];
    staleCutoffMs = 10_000;
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, true);
    r.setReinjectDirect(reinject);

    await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(1);
    expect(reinject).not.toHaveBeenCalled();
  });

  it('releaseClaim hands a claimed row back for retry', async () => {
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date() })];
    const r = makeReplayer(rows, false);

    expect(await r.releaseClaim(1, 'pipeline threw')).toBe(true);
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(1);
    expect(rows[0]!.last_error).toBe('pipeline threw');
    expect(rows[0]!.claimed_at).toBeNull();
  });

  it('releaseClaim refuses a row it does not hold', async () => {
    // A worker whose claim was reclaimed underneath it must not yank a row a
    // different worker now owns.
    const rows = [row(1, { status: OverflowStatus.enum.buffered })];
    const r = makeReplayer(rows, false);

    expect(await r.releaseClaim(1, 'pipeline threw')).toBe(false);
    expect(rows[0]!.replay_attempts).toBe(0);
    expect(rows[0]!.last_error).toBeNull();
  });
});
