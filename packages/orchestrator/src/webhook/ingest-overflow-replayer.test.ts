import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { IngestOverflowReplayer } from './ingest-overflow-replayer.js';
import { OverflowSourceKind, OverflowStatus } from './ingest-overflow-types.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import type { AdmitResult } from './ingest-admission.js';
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
            // Age-expiry arm: .where(status).where('captured_at','<',cutoff).limit(n)
            if (second === 'captured_at') {
              return {
                limit: (n: number) => ({
                  execute: async () =>
                    rows
                      .filter(
                        (r) => r.status === val && r.captured_at.getTime() < (v2 as Date).getTime(),
                      )
                      .slice(0, n),
                }),
                executeTakeFirst: async () => undefined,
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

/**
 * Fake admission controller. `headroom` decides whether a reservation is
 * granted; `sheddingKeys` narrows a refusal to specific fairness keys so the
 * cross-org fair-skip can be driven. Every grant records the key, and
 * `released` counts the releases, so a leaked slot is visible.
 */
function makeController(opts: {
  shedding?: boolean;
  headroom?: boolean;
  refuseKeys?: Set<string>;
  reason?: 'queue_full' | 'loop_overload';
}) {
  const granted: string[] = [];
  let released = 0;
  const refuse = (key: string): boolean =>
    opts.headroom === false || (opts.refuseKeys?.has(key) ?? false);
  return {
    granted,
    get released() {
      return released;
    },
    isShedding: () => opts.shedding ?? false,
    reserve: vi.fn((key: string, _orgCap: number): AdmitResult => {
      if (refuse(key)) return { admitted: false, reason: opts.reason ?? 'queue_full' };
      granted.push(key);
      return {
        admitted: true,
        release: () => {
          released++;
        },
      };
    }),
  };
}

type FakeController = ReturnType<typeof makeController>;

/** The clock every test drives from; well past every fixture's `captured_at`. */
const NOW_MS = 10_000_000;

function makeReplayer(
  rows: Row[],
  controller: FakeController,
  over: { batchSize?: number; maxAttempts?: number; maxAgeMs?: number; now?: () => number } = {},
) {
  return new IngestOverflowReplayer({
    db: makeFakeDb(rows),
    controller,
    resolveAdmissionKey: async (routingKey) => ({ key: `org:${routingKey}`, orgCap: 32 }),
    intervalMs: 1000,
    batchSize: over.batchSize ?? 10,
    maxAttempts: over.maxAttempts ?? 3,
    // Far beyond any fixture age, so retention is inert unless a test opts in.
    maxAgeMs: over.maxAgeMs ?? 1_000_000_000,
    claimTimeoutMs: 900_000,
    now: over.now ?? (() => NOW_MS),
  });
}

/** The common case: capacity available, nothing shedding. */
const withHeadroom = () => makeController({ headroom: true });

describe('IngestOverflowReplayer', () => {
  beforeEach(() => {
    resetIngestOverflowMetricState();
    // Nothing is stale by default; the reclaim tests raise this explicitly.
    staleCutoffMs = 0;
  });

  it('skips the drain while isShedding() is latched, without touching the row', async () => {
    // `isShedding()` is the loop-lag / CoDel latch only. It is a cheap
    // short-circuit, NOT the gate — it cannot observe the per-key `queue_full`
    // refusal that is the common case, which the sibling test below drives.
    // The controller here grants freely, so a pass that ran at all would drain.
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const controller = makeController({ shedding: true, headroom: true });
    const r = makeReplayer(rows, controller);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(reinject).not.toHaveBeenCalled();
    expect(controller.reserve).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(0);
  });

  it('skips the drain on a per-key queue_full refusal, with isShedding() false', async () => {
    // The state that actually occurs. Every shed measured on staging was a
    // per-key `queue_full` from the layer-2 caps, and `isShedding()` was false
    // for every one of them — so the test above covers a state the failure
    // population never entered, and this one covers the state it always did.
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const controller = makeController({ shedding: false, headroom: false });
    const r = makeReplayer(rows, controller);
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(controller.isShedding()).toBe(false);
    expect(controller.reserve).toHaveBeenCalledTimes(1);
    expect(reinject).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(0);
    expect(rows[0]!.last_error).toBeNull();
  });

  it('drains oldest-first and marks replayed on success (then sweeps)', async () => {
    const rows = [row(2), row(1)]; // captured_at 1002, 1001
    const seen: string[] = [];
    const reinject = vi.fn(async (d) => {
      seen.push(d.deliveryId);
      return WebhookIngestOutcome.enum.processed;
    });
    const r = makeReplayer(rows, withHeadroom());
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(seen).toEqual(['d-1', 'd-2']); // FIFO by captured_at
    expect(rows).toHaveLength(0); // replayed rows swept
  });

  it('reverts to buffered (not lost) and bumps attempts on a re-shed', async () => {
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.shed);
    const r = makeReplayer(rows, withHeadroom());
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(1);
  });

  it('marks failed at max attempts', async () => {
    const rows = [row(1, { replay_attempts: 2 })]; // one more → 3 == maxAttempts
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.shed);
    const r = makeReplayer(rows, withHeadroom());
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.failed);
    expect(rows[0]!.replay_attempts).toBe(3);
  });

  it('honors the batch size bound', async () => {
    const rows = [row(1), row(2), row(3)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, withHeadroom(), { batchSize: 2 });
    r.setReinjectDirect(reinject);
    await r.runPass();
    expect(reinject).toHaveBeenCalledTimes(2);
  });

  it('a duplicate delivery id replays as duplicate → success, no double dispatch', async () => {
    // processWebhook returns `duplicate` when the dedup claim loses; the replayer
    // treats duplicate/skipped/processed all as terminal success (row removed).
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.duplicate);
    const r = makeReplayer(rows, withHeadroom());
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
    const r = makeReplayer(rows, withHeadroom());
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
    const r = makeReplayer(rows, withHeadroom());
    r.setReinjectDirect(reinject);

    await r.runPass();

    // Reclaiming a live worker's row would re-run a pipeline still in flight.
    expect(reinject).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.replaying);
  });

  it('reclaims while the controller is shedding, without re-injecting', async () => {
    // A stranded claim is stranded regardless of load. Freeing it under shed is
    // safe because the freed row waits in `buffered`.
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date(1) })];
    staleCutoffMs = 10_000;
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, makeController({ shedding: true, headroom: true }));
    r.setReinjectDirect(reinject);

    await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(1);
    expect(reinject).not.toHaveBeenCalled();
  });

  it('releaseClaim hands a claimed row back for retry', async () => {
    const rows = [row(1, { status: OverflowStatus.enum.replaying, claimed_at: new Date() })];
    const r = makeReplayer(rows, withHeadroom());

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
    const r = makeReplayer(rows, withHeadroom());

    expect(await r.releaseClaim(1, 'pipeline threw')).toBe(false);
    expect(rows[0]!.replay_attempts).toBe(0);
    expect(rows[0]!.last_error).toBeNull();
  });
  // ── Reserve-then-claim: convergence, termination, and the guard-defeat check ──

  it('converges after 20 consecutive refusals, with replay_attempts still 0', async () => {
    // The convergence assertion. 20 is a LITERAL above maxAttempts (3), not
    // `maxAttempts * N` — a derived bound passes for every value of maxAttempts,
    // including one the implementation ignores.
    //
    // fails-when: the row is claimed before the reservation is granted. Under
    //   the old ordering every refused pass called revertOrFail, so the row was
    //   `failed` with replay_attempts=3 by pass 3 and never reached `replayed`.
    // breaks-if-wrong: a GENUINE failure must still spend an attempt — the
    //   'a reinject that throws 20 times still fails at the ceiling' test below
    //   is that mirror, and 'marks failed at max attempts' is the untouched
    //   positive counterpart.
    const rows = [row(1)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    let refusing = true;
    const controller = makeController({ headroom: true });
    controller.reserve.mockImplementation((key: string): AdmitResult => {
      if (refusing) return { admitted: false, reason: 'queue_full' };
      controller.granted.push(key);
      return { admitted: true, release: () => {} };
    });
    const r = makeReplayer(rows, controller);
    r.setReinjectDirect(reinject);

    for (let pass = 0; pass < 20; pass++) await r.runPass();

    // Twenty refused passes cost the delivery nothing at all.
    expect(reinject).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(0);

    refusing = false;
    await r.runPass();

    expect(reinject).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0); // replayed, then swept
  });

  it('a reinject that throws 20 times still fails at the attempt ceiling', async () => {
    // The termination mirror of the assertion above: only the CAPACITY path was
    // exempted, so the ceiling is still load-bearing for real failures.
    //
    // fails-when: an implementation stops counting attempts altogether (e.g. by
    //   exempting every revert, not just the capacity path) — the row would stay
    //   `buffered` forever instead of reaching `failed` at attempt 3.
    // breaks-if-wrong: the convergence test above is the positive counterpart —
    //   a refused delivery must NOT be failed by this path.
    const rows = [row(1)];
    const reinject = vi.fn(async () => {
      throw new Error('pipeline blew up');
    });
    const r = makeReplayer(rows, withHeadroom());
    r.setReinjectDirect(reinject);

    for (let pass = 0; pass < 20; pass++) await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.failed);
    expect(rows[0]!.replay_attempts).toBe(3); // maxAttempts, not 20
    expect(rows[0]!.last_error).toContain('pipeline blew up');
    // Nothing is attempted once the row leaves `buffered`.
    expect(reinject).toHaveBeenCalledTimes(3);
  });

  it('performs zero reinjects and claims zero rows when the controller refuses', async () => {
    // The guard-defeat check: this is what reddens if anyone gives replay an
    // exempt lane.
    //
    // fails-when: the reservation is bypassed — the reinject spy fires and the
    //   row leaves `buffered`.
    // breaks-if-wrong: see the paired assertion at the end — with headroom the
    //   same fixture MUST drain, otherwise a reservation that is always refused
    //   would satisfy the first half perfectly.
    const rows = [row(1), row(2), row(3)];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const atCapacity = makeController({ headroom: false });
    const r = makeReplayer(rows, atCapacity);
    r.setReinjectDirect(reinject);

    await r.runPass();

    expect(reinject).not.toHaveBeenCalled();
    expect(atCapacity.granted).toEqual([]);
    for (const rw of rows) {
      expect(rw.status).toBe(OverflowStatus.enum.buffered);
      expect(rw.replay_attempts).toBe(0);
    }

    // The positive counterpart, same fixture, headroom restored.
    const drainRows = [row(1), row(2), row(3)];
    const drainSpy = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const open = withHeadroom();
    const r2 = makeReplayer(drainRows, open);
    r2.setReinjectDirect(drainSpy);
    await r2.runPass();
    expect(drainSpy).toHaveBeenCalledTimes(3);
    expect(drainRows).toHaveLength(0);
  });

  it('releases the reservation after every re-injection, success or throw', async () => {
    // A leaked grant is an invisible bypass in the other direction: it would
    // consume real admission slots the live ingest paths need.
    const rows = [row(1), row(2)];
    const controller = withHeadroom();
    const r = makeReplayer(rows, controller);
    let calls = 0;
    r.setReinjectDirect(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return WebhookIngestOutcome.enum.processed;
    });

    await r.runPass();

    expect(controller.granted).toHaveLength(2);
    expect(controller.released).toBe(2);
  });

  it('skips a saturated org for the pass while other orgs keep draining', async () => {
    // Cross-org head-of-line: breaking out of the batch on the first refusal
    // would let a saturated org A block org B's rows behind it in the FIFO.
    const rows = [
      row(1, { routing_key: 'saturated' }),
      row(2, { routing_key: 'saturated' }),
      row(3, { routing_key: 'free' }),
    ];
    const seen: string[] = [];
    const controller = makeController({ refuseKeys: new Set(['org:saturated']) });
    const r = makeReplayer(rows, controller);
    r.setReinjectDirect(async (d) => {
      seen.push(d.deliveryId);
      return WebhookIngestOutcome.enum.processed;
    });

    await r.runPass();

    expect(seen).toEqual(['d-3']);
    // One refusal for the saturated key, not one per row behind it.
    expect(controller.reserve).toHaveBeenCalledTimes(2);
    // d-3 replayed and was swept; the two saturated rows are untouched.
    expect(rows.map((rw) => rw.delivery_id)).toEqual(['d-1', 'd-2']);
    for (const rw of rows) {
      expect(rw.status).toBe(OverflowStatus.enum.buffered);
      expect(rw.replay_attempts).toBe(0);
    }
  });

  // ── The retention bound ──────────────────────────────────────────────────

  it('fails a row past the max age even while the controller refuses forever', async () => {
    // Without a bound, "a refusal costs no attempt" is an unbounded hold that
    // fills the cap and starts dropping FRESH captures instead.
    //
    // fails-when: no retention bound exists — the row is still `buffered` a tick
    //   past the TTL rather than `failed`.
    // breaks-if-wrong: the sibling test below is the mirror — a row YOUNGER than
    //   the TTL that is merely being refused must stay `buffered`, or the TTL is
    //   just a shorter attempt ceiling wearing a clock.
    const rows = [row(1, { captured_at: new Date(NOW_MS - 61_000) })];
    const reinject = vi.fn(async () => WebhookIngestOutcome.enum.processed);
    const r = makeReplayer(rows, makeController({ headroom: false }), { maxAgeMs: 60_000 });
    r.setReinjectDirect(reinject);

    await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.failed);
    expect(rows[0]!.last_error).toContain('expired after 60000ms');
    // Expired, never replayed: an over-age delivery is not re-injected.
    expect(reinject).not.toHaveBeenCalled();
  });

  it('leaves a row younger than the max age buffered while it is refused', async () => {
    const rows = [row(1, { captured_at: new Date(NOW_MS - 59_000) })];
    const r = makeReplayer(rows, makeController({ headroom: false }), { maxAgeMs: 60_000 });
    r.setReinjectDirect(async () => WebhookIngestOutcome.enum.processed);

    await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.buffered);
    expect(rows[0]!.replay_attempts).toBe(0);
    expect(rows[0]!.last_error).toBeNull();
  });

  it('does not expire a row a worker is actively holding', async () => {
    // Expiry only ever touches `buffered`, which is why maxAgeMs may equal
    // claimTimeoutMs without the two bounds racing: the reclaim hands the row
    // back to `buffered` first, and a later pass expires it there.
    const rows = [
      row(1, {
        status: OverflowStatus.enum.replaying,
        claimed_at: new Date(NOW_MS - 1_000),
        captured_at: new Date(NOW_MS - 999_000),
      }),
    ];
    const r = makeReplayer(rows, withHeadroom(), { maxAgeMs: 60_000 });
    r.setReinjectDirect(async () => WebhookIngestOutcome.enum.processed);

    await r.runPass();

    expect(rows[0]!.status).toBe(OverflowStatus.enum.replaying);
  });
});
