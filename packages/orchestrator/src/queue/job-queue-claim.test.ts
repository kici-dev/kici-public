import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus, JobQueue, type QueuedJobInput } from './job-queue.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres correctness tests for the dispatch-queue claim.
 *
 * A claim has to be ONE statement. A `SELECT … FOR UPDATE SKIP LOCKED` returning
 * the row still Pending, then a separate `markDispatched`, is not a claim:
 * outside a transaction the row lock lasts only for its own SELECT, so a second
 * claimant in between dispatches the same job — it runs twice on two agents,
 * with every side effect of the customer's steps performed twice.
 *
 * Mock-based coverage is in job-queue.test.ts; this file proves the arbiter on a
 * real Postgres, across BOTH claim routes and the cross-route pairing observed
 * live (an eager bound `dequeueById` colliding with a generic
 * `dequeueForLabels` drain 50 ms apart).
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL, which the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies from a throwaway container.
 */
describeWithTestDb<Database>(
  'JobQueue claim — exactly one claimant per job (real Postgres)',
  { prefix: 'kici_queue_claim_test', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    let db: Kysely<Database>;
    let queue: JobQueue;

    const jobInput = (overrides: Partial<QueuedJobInput> = {}): QueuedJobInput => ({
      runId: 'run-1',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: ['linux', 'docker'],
      jobConfig: { timeout: 300 },
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: `delivery-${Math.random()}`,
      provider: 'github',
      providerContext: { installationId: 42 },
      routingKey: 'github:42',
      ...overrides,
    });

    const statusOf = async (jobId: string): Promise<{ status: string; agentId: string | null }> => {
      const row = await db
        .selectFrom('dispatch_queue')
        .select(['status', 'agent_id'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
      return { status: row.status, agentId: row.agent_id ?? null };
    };

    beforeAll(() => {
      ({ db } = getDb());
      queue = new JobQueue(db, { maxDepth: 1000, defaultTimeoutMs: 600_000 });
    });

    beforeEach(async () => {
      await sql`TRUNCATE TABLE dispatch_queue`.execute(db);
    });

    // ── The defect, stated as a sequence ────────────────────────────────────
    //
    // The deterministic form of the race: no call runs `markDispatched`, the
    // window in which both SELECTs completed before either transition landed.
    // A select-then-update claim returns the SAME job twice here.

    it('dequeueForLabels — a second generic drain cannot re-claim the same row', async () => {
      const id = await queue.enqueue(jobInput());

      const first = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a');
      const second = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-b');

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
    });

    it('dequeueById — a second eager bound claim cannot re-claim the same row', async () => {
      const id = await queue.enqueue(jobInput());

      const first = await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-a');
      const second = await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-b');

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
    });

    it('cross-route — an eager bound claim and a generic drain cannot both take one job', async () => {
      // The pairing observed live: a scaler agent spawned bound to the job
      // claimed it eagerly while an already-idle agent drained it generically.
      const id = await queue.enqueue(jobInput());

      const eager = await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-bound');
      const generic = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-idle');

      expect(eager?.id).toBe(id);
      expect(generic).toBeNull();

      // …and in the other order, since either can arrive first.
      const id2 = await queue.enqueue(jobInput());
      const generic2 = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-idle');
      const eager2 = await queue.dequeueById(id2, ['linux', 'docker'], [], 'agent-bound');

      expect(generic2?.id).toBe(id2);
      expect(eager2).toBeNull();
    });

    it('dequeueByPinnedAgent — a second pinned drain cannot re-claim the same row', async () => {
      const id = await queue.enqueue(jobInput({ pinnedAgentId: 'host-1' }));

      const first = await queue.dequeueByPinnedAgent('host-1', ['linux', 'docker']);
      const second = await queue.dequeueByPinnedAgent('host-1', ['linux', 'docker']);

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
    });

    it('the pattern path claims atomically too', async () => {
      const id = await queue.enqueue(
        jobInput({
          runsOnLabels: [],
          runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
        }),
      );

      const first = await queue.dequeueForLabels(['kici:host:box-02'], [], 'agent-a');
      const second = await queue.dequeueForLabels(['kici:host:box-02'], [], 'agent-b');

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
    });

    // ── The suitability post-filter ─────────────────────────────────────────
    //
    // The gate runs BEFORE the transition: a claimed-then-put-back row is
    // stranded Dispatched for the round trip, and every put-back spends one of the
    // job's bounded dispatch attempts — an agent that can never serve the job
    // would fail it by polling.

    it('a rejected row is left Pending, never claimed and released', async () => {
      const id = await queue.enqueue(jobInput());

      const job = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a', () => false);

      expect(job).toBeNull();
      expect(await statusOf(id)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });

    it('an accepted row is claimed atomically through the post-filter path', async () => {
      const id = await queue.enqueue(jobInput());

      const first = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a', () => true);
      const second = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-b', () => true);

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
      expect(await statusOf(id)).toEqual({
        status: DispatchQueueStatus.Dispatched,
        agentId: 'agent-a',
      });
    });

    it('the post-filter skips a rejected row and claims the next one', async () => {
      const rejected = await queue.enqueue(jobInput({ jobName: 'wrong-shape' }));
      const accepted = await queue.enqueue(jobInput({ jobName: 'right-shape' }));

      const job = await queue.dequeueForLabels(
        ['linux', 'docker'],
        [],
        'agent-a',
        (candidate) => candidate.jobName === 'right-shape',
      );

      expect(job?.id).toBe(accepted);
      expect(await statusOf(rejected)).toEqual({
        status: DispatchQueueStatus.Pending,
        agentId: null,
      });
    });

    it('the post-filter path still applies the regex matchers', async () => {
      await queue.enqueue(
        jobInput({
          runsOnLabels: [],
          runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
        }),
      );

      const wrongHost = await queue.dequeueForLabels(
        ['kici:host:other'],
        [],
        'agent-a',
        () => true,
      );
      const rightHost = await queue.dequeueForLabels(
        ['kici:host:box-02'],
        [],
        'agent-b',
        () => true,
      );

      expect(wrongHost).toBeNull();
      expect(rightHost).not.toBeNull();
    });

    // ── The claim IS the transition ─────────────────────────────────────────

    it('a won claim leaves the row dispatched and owned, before markDispatched runs', async () => {
      const id = await queue.enqueue(jobInput());

      await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a');

      // No markDispatched yet: the row must already be off Pending AND carry its
      // owner, so a crash in this window cannot strand a Dispatched row with no
      // agent for the ownership lookups to resolve against.
      expect(await statusOf(id)).toEqual({
        status: DispatchQueueStatus.Dispatched,
        agentId: 'agent-a',
      });
    });

    it('a lost claim leaves the winner untouched — the job is never invisible', async () => {
      const id = await queue.enqueue(jobInput());

      await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a');
      const loser = await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-b');

      expect(loser).toBeNull();
      // The loser must not have rewritten the owner: the job belongs to the
      // winner, and the row stays exactly one dispatched job.
      expect(await statusOf(id)).toEqual({
        status: DispatchQueueStatus.Dispatched,
        agentId: 'agent-a',
      });
    });

    it('markDispatched after a claim is idempotent, not a second transition', async () => {
      const id = await queue.enqueue(jobInput());
      const job = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a');
      expect(job).not.toBeNull();

      await queue.markDispatched(id, 'agent-a');

      expect(await statusOf(id)).toEqual({
        status: DispatchQueueStatus.Dispatched,
        agentId: 'agent-a',
      });
    });

    // ── Under genuine concurrency ───────────────────────────────────────────

    it('N concurrent drains over one job yield exactly one winner', async () => {
      const id = await queue.enqueue(jobInput());

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          queue.dequeueForLabels(['linux', 'docker'], [], `agent-${i}`),
        ),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.id).toBe(id);
    });

    it('N concurrent drains over N jobs still hand out every job — SKIP LOCKED is preserved', async () => {
      // A select-then-conditionally-update claim would have each loser return
      // empty-handed while other jobs sat pending. The FOR UPDATE SKIP LOCKED
      // sub-select inside the claiming UPDATE makes a concurrent claimant skip
      // to the NEXT row instead.
      const ids = new Set<string>();
      for (let i = 0; i < 6; i++) ids.add(await queue.enqueue(jobInput({ jobName: `job-${i}` })));

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          queue.dequeueForLabels(['linux', 'docker'], [], `agent-${i}`),
        ),
      );

      const claimed = results.filter((r) => r !== null).map((r) => r!.id);
      expect(new Set(claimed)).toEqual(ids);
    });

    // ── The claim does not swallow the routing gates ────────────────────────

    it('a non-matching agent claims nothing and leaves the row pending', async () => {
      const id = await queue.enqueue(jobInput({ runsOnLabels: ['linux', 'gpu'] }));

      expect(await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a')).toBeNull();
      expect(await statusOf(id)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });

    it('a pattern-rejected bound job is left pending, never claimed-then-stranded', async () => {
      const id = await queue.enqueue(
        jobInput({
          runsOnLabels: [],
          runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
        }),
      );

      // The SQL predicates pass (no exact labels to satisfy); only the JS matcher
      // rejects. That filter runs BEFORE the claim, so the row must stay pending
      // and remain drainable by the agent it is actually for.
      expect(await queue.dequeueById(id, ['kici:host:web-09'], [], 'agent-wrong')).toBeNull();
      expect(await statusOf(id)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });

      const right = await queue.dequeueById(id, ['kici:host:box-02'], [], 'agent-right');
      expect(right?.id).toBe(id);
    });

    it('an expired job is not claimable', async () => {
      const id = await queue.enqueue(jobInput());
      await db
        .updateTable('dispatch_queue')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', id)
        .execute();

      expect(await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a')).toBeNull();
      expect(await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-a')).toBeNull();
    });

    // ── Case folding across the SQL prefilter ───────────────────────────────
    //
    // `@>` and `= ANY(...)` are Postgres byte comparisons, so only a real db
    // shows whether they fold. A job the prefilter drops never reaches the JS
    // post-filter, so this decides whether a mixed-case label routes at all.

    it('claims a job enqueued with mixed-case labels for a canonical agent', async () => {
      const id = await queue.enqueue(jobInput({ runsOnLabels: ['Linux', 'Docker'] }));
      const claimed = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a');
      expect(claimed?.id).toBe(id);
      expect(claimed?.runsOnLabels).toEqual(['linux', 'docker']);
    });

    it('claims a canonical job for an agent advertising mixed-case labels', async () => {
      const id = await queue.enqueue(jobInput({ runsOnLabels: ['linux', 'docker'] }));
      const claimed = await queue.dequeueForLabels(['LINUX', 'Docker'], [], 'agent-a');
      expect(claimed?.id).toBe(id);
    });

    it('honours a mixed-case exclude label against a canonical agent label', async () => {
      // The direction that fails OPEN: without the fold the job drains onto
      // exactly the agent its `excludeLabels` named.
      await queue.enqueue(
        jobInput({ runsOnLabels: ['linux'], excludeLabels: ['Spot'], deliveryId: 'excl-1' }),
      );
      expect(await queue.dequeueForLabels(['linux', 'spot'], [], 'agent-a')).toBeNull();
      // …and an agent without the excluded label still gets it.
      expect(await queue.dequeueForLabels(['linux'], [], 'agent-b')).not.toBeNull();
    });

    it('satisfies a mixed-case mandatory gate through the SQL containment check', async () => {
      const id = await queue.enqueue(jobInput({ runsOnLabels: ['linux', 'gpu'] }));
      const claimed = await queue.dequeueForLabels(['linux', 'gpu'], ['GPU'], 'agent-a');
      expect(claimed?.id).toBe(id);
    });

    it('dequeueById folds both sides too', async () => {
      const id = await queue.enqueue(jobInput({ runsOnLabels: ['Linux', 'Docker'] }));
      const claimed = await queue.dequeueById(id, ['linux', 'docker'], [], 'agent-a');
      expect(claimed?.id).toBe(id);
    });

    it('a requeued job becomes claimable again — recovery is not retired', async () => {
      const id = await queue.enqueue(jobInput());
      expect(await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a')).not.toBeNull();

      // job.reject / scaler-agent disconnect path.
      expect(await queue.requeue(id)).toBe(1);
      expect(await statusOf(id)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });

      const second = await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-b');
      expect(second?.id).toBe(id);
      expect(await statusOf(id)).toEqual({
        status: DispatchQueueStatus.Dispatched,
        agentId: 'agent-b',
      });
    });

    it('a busy requeue returns the job to pending without spending an attempt', async () => {
      const id = await queue.enqueue(jobInput());
      expect(await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a')).not.toBeNull();
      expect(await queue.requeue(id)).toBe(1);
      expect(await queue.dequeueForLabels(['linux', 'docker'], [], 'agent-a')).not.toBeNull();

      // fails-when: the increment ignores countAttempt — the row reads 2.
      expect(await queue.requeue(id, { countAttempt: false })).toBe(1);
      expect(await statusOf(id)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });
  },
);
