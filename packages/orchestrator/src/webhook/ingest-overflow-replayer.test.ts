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
}

/**
 * Fake Kysely covering the replayer's queries:
 *  - selectFrom(...).selectAll().where().orderBy().limit(N).execute() — claim candidates
 *  - selectFrom(...).select(count).where().executeTakeFirstOrThrow() — depth gauge
 *  - updateTable(...).set(patch).where(id).where(status?)...            — claim / status update
 *  - deleteFrom(...).where().execute()                                 — sweep replayed
 */
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
      // .select(countFn) → depth-gauge chain.
      select: () => ({
        where: () => ({
          executeTakeFirstOrThrow: async () => ({ count: String(buffered().length) }),
        }),
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
  });
}

describe('IngestOverflowReplayer', () => {
  beforeEach(() => resetIngestOverflowMetricState());

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
});
