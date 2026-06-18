/**
 * Tests for the DB-backed job queue (PostgreSQL only).
 *
 * Unit tests use mockDb() to verify queue logic: depth checks,
 * SQL-based JSONB label matching, FIFO ordering, status transitions, and timeout expiry.
 * Integration tests would use @testcontainers/postgresql.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobQueue, DispatchQueueStatus, type QueuedJobInput } from './job-queue.js';

// ── Mock helpers ────────────────────────────────────────────────

function makeJobInput(overrides: Partial<QueuedJobInput> = {}): QueuedJobInput {
  return {
    runId: 'run-1',
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux', 'docker'],
    jobConfig: { timeout: 300 },
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: 'delivery-1',
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
    ...overrides,
  };
}

function makeDbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    run_id: 'run-1',
    workflow_name: 'ci',
    job_name: 'build',
    runs_on_labels: JSON.stringify(['linux', 'docker']),
    job_config: JSON.stringify({ timeout: 300 }),
    repo_url: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    status: DispatchQueueStatus.Pending,
    created_at: '2026-02-08T10:00:00.000Z',
    expires_at: '2026-02-08T10:10:00.000Z',
    delivery_id: 'delivery-1',

    provider: 'github',
    provider_context: '{"installationId":42}',
    routing_key: 'github:42',
    pinned_agent_id: null,
    ...overrides,
  };
}

/**
 * Create a mock Kysely db that supports the query chains used by JobQueue.
 * Wraps the shared mock-db helper with a backward-compatible `_mocks` property.
 */
import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

function createMockDb(
  options: {
    selectRows?: Record<string, unknown>[];
    selectFirstRow?: unknown;
    countResult?: { count: number };
    updateResult?: { numUpdatedRows: bigint };
    updateReturning?: unknown;
  } = {},
) {
  const countResult = options.countResult ?? { count: 0 };
  const { db, mocks } = _createMockDb({
    selectRows: options.selectRows ?? [],
    // Route count queries through selectFirstRow since getDepth() uses
    // selectFrom().select(fn.countAll()).where().executeTakeFirst()
    // which goes through the select terminal chain.
    selectFirstRow: 'selectFirstRow' in options ? options.selectFirstRow : countResult,
    countResult,
    updateResult: options.updateResult ?? { numUpdatedRows: 0n },
    updateReturning: options.updateReturning,
  });

  // Expose _mocks for backward-compatible assertions (tests reference db._mocks.values etc.)
  db._mocks = {
    execute: mocks.selectExecute,
    executeTakeFirst: mocks.updateExecuteTakeFirst,
    countExecuteTakeFirst: mocks.countExecuteTakeFirst,
    values: mocks.insertValues,
    where: mocks.selectWhere,
    updateWhere: mocks.updateWhere,
    set: mocks.updateSet,
    selectAll: mocks.selectAll,
    orderBy: mocks.selectOrderBy,
    selectForUpdate: mocks.selectForUpdate,
    selectSkipLocked: mocks.selectSkipLocked,
  };

  return db;
}

// ── Tests ───────────────────────────────────────────────────────

describe('JobQueue', () => {
  describe('enqueue', () => {
    it('inserts a job and returns an ID', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const id = await queue.enqueue(makeJobInput());

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(db.insertInto).toHaveBeenCalledWith('dispatch_queue');
    });

    it('rejects when queue is full (depth >= maxDepth)', async () => {
      const db = createMockDb({ countResult: { count: 5 } });
      const queue = new JobQueue(db, { maxDepth: 5, defaultTimeoutMs: 600_000 });

      await expect(queue.enqueue(makeJobInput())).rejects.toThrow('queue full');
    });

    it('passes correct values to insertInto', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.enqueue(
        makeJobInput({
          runId: 'run-42',
          workflowName: 'deploy',
          jobName: 'build-arm',
          runsOnLabels: ['arm64'],
          provider: 'github',
          providerContext: { installationId: 99 },
        }),
      );

      const valuesCall = db._mocks.values;
      expect(valuesCall).toHaveBeenCalledTimes(1);
      const arg = valuesCall.mock.calls[0][0];
      expect(arg.run_id).toBe('run-42');
      expect(arg.workflow_name).toBe('deploy');
      expect(arg.job_name).toBe('build-arm');
      expect(arg.runs_on_labels).toBe(JSON.stringify(['arm64']));

      expect(arg.provider).toBe('github');
      expect(arg.provider_context).toBe(JSON.stringify({ installationId: 99 }));
      expect(arg.status).toBe(DispatchQueueStatus.Pending);
    });

    it('computes expires_at from default timeout', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const before = Date.now();
      await queue.enqueue(makeJobInput());
      const after = Date.now();

      const valuesCall = db._mocks.values;
      const arg = valuesCall.mock.calls[0][0];
      expect(arg.expires_at).toBeDefined();

      // expires_at should be ~10 minutes from now
      const expiresAt = new Date(arg.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 600_000);
    });

    it('sets null expires_at when timeoutMs is 0 (indefinite)', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 0 });

      await queue.enqueue(makeJobInput());

      const valuesCall = db._mocks.values;
      const arg = valuesCall.mock.calls[0][0];
      expect(arg.expires_at).toBeNull();
    });

    it('respects per-job timeout override', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.enqueue(makeJobInput({ timeoutMs: 0 }));

      const valuesCall = db._mocks.values;
      const arg = valuesCall.mock.calls[0][0];
      expect(arg.expires_at).toBeNull();
    });

    it('round-trips runsOnPatterns/excludePatterns through enqueue + read', async () => {
      const runsOnPatterns = [{ kind: 'regex' as const, source: '^kici:host:box-', flags: '' }];
      const excludePatterns = [{ kind: 'regex' as const, source: '-canary$', flags: '' }];

      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
      await queue.enqueue(
        makeJobInput({ runsOnLabels: ['role:web'], runsOnPatterns, excludePatterns }),
      );

      // Enqueue persists the serialized pattern columns.
      const arg = db._mocks.values.mock.calls[0][0];
      expect(arg.runs_on_patterns).toBe(JSON.stringify(runsOnPatterns));
      expect(arg.exclude_patterns).toBe(JSON.stringify(excludePatterns));

      // rowToQueuedJob parses both the auto-parsed array form and the JSON
      // string form back into LabelMatcher[].
      const readDb = createMockDb({
        selectFirstRow: makeDbRow({
          runs_on_patterns: runsOnPatterns, // pg-driver auto-parsed array
          exclude_patterns: JSON.stringify(excludePatterns), // JSON string form
        }),
      });
      const readQueue = new JobQueue(readDb, { maxDepth: 100, defaultTimeoutMs: 600_000 });
      const job = await readQueue.getFullJobById('job-1');
      expect(job?.runsOnPatterns).toEqual(runsOnPatterns);
      expect(job?.excludePatterns).toEqual(excludePatterns);
    });

    it('defaults pattern columns to [] when none provided', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
      await queue.enqueue(makeJobInput());
      const arg = db._mocks.values.mock.calls[0][0];
      expect(arg.runs_on_patterns).toBe('[]');
      expect(arg.exclude_patterns).toBe('[]');
    });
  });

  describe('dequeueForLabels', () => {
    it('returns matching job from SQL JSONB containment query', async () => {
      const row = makeDbRow({
        id: 'job-oldest',
        runs_on_labels: ['linux', 'docker'], // JSONB auto-parsed by driver
      });
      // dequeueForLabels uses executeTakeFirst (LIMIT 1), not execute
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker', 'gpu']);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('job-oldest');
      expect(result!.runsOnLabels).toEqual(['linux', 'docker']);
    });

    it('returns null when SQL query returns no rows', async () => {
      // No matching rows from the SQL containment query
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux']);

      expect(result).toBeNull();
    });

    it('returns null when queue is empty', async () => {
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux']);

      expect(result).toBeNull();
    });

    it('handles JSONB auto-parsed array from driver', async () => {
      // PostgreSQL driver auto-parses JSONB columns to native arrays
      const row = makeDbRow({
        id: 'job-jsonb',
        runs_on_labels: ['linux', 'arm64'], // Already parsed by driver
      });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'arm64']);

      expect(result).not.toBeNull();
      expect(result!.runsOnLabels).toEqual(['linux', 'arm64']);
    });

    it('uses FOR UPDATE SKIP LOCKED for concurrent safety', async () => {
      const row = makeDbRow({ id: 'job-locked' });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.dequeueForLabels(['linux']);

      // Verify the locking clause is part of the query chain
      expect(db._mocks.selectForUpdate).toHaveBeenCalled();
      expect(db._mocks.selectSkipLocked).toHaveBeenCalled();
    });

    it('filters out expired pending jobs', async () => {
      // Expired job should not be returned even if status is still 'pending'
      // (cleanup hasn't run yet). The SQL WHERE clause includes
      // (expires_at IS NULL OR expires_at >= now()) to prevent dispatching expired jobs.
      const expiredRow = makeDbRow({
        id: 'job-expired',
        expires_at: '2020-01-01T00:00:00.000Z', // well in the past
      });
      // Since the WHERE clause filters at DB level, the mock returns undefined
      // (no matching rows) when the job is expired
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker']);

      expect(result).toBeNull();
    });

    it('returns job with null expires_at (indefinite timeout)', async () => {
      const row = makeDbRow({ id: 'job-no-expiry', expires_at: null });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker']);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('job-no-expiry');
    });

    it('handles string runs_on_labels (fallback for non-JSONB drivers)', async () => {
      // When runs_on_labels comes back as a string (e.g., mock DB or test context)
      const row = makeDbRow({
        id: 'job-string',
        runs_on_labels: JSON.stringify(['linux', 'docker']),
      });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker']);

      expect(result).not.toBeNull();
      expect(result!.runsOnLabels).toEqual(['linux', 'docker']);
    });

    it('omits the mandatory-labels predicate when agentMandatoryLabels is empty', async () => {
      const row = makeDbRow({
        id: 'job-no-gate',
        runs_on_labels: ['linux', 'docker'],
      });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker']);

      expect(result).not.toBeNull();
      // Fast-path `where` clauses: status, expiry, jsonb subset, NOT EXISTS
      // exclude, the pin predicate (pinned_agent_id IS NULL [OR = agent]), and
      // the pattern-free guard (runs_on_patterns = '[]' AND exclude_patterns =
      // '[]') = 6. The `runs_on_labels @> :gate` containment must NOT be added
      // when agentMandatoryLabels is empty (it would be a no-op against an empty
      // JSONB array but leaving it off keeps the query cheap).
      expect(db._mocks.where).toHaveBeenCalledTimes(6);
    });

    it('adds the mandatory-labels containment predicate when gate is non-empty', async () => {
      const row = makeDbRow({
        id: 'gated-job',
        runs_on_labels: ['linux', 'gpu'],
      });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'gpu', 'docker'], ['gpu']);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('gated-job');
      // Fast-path baseline (6, incl. pin predicate + pattern-free guard) + the
      // gate predicate (1) = 7.
      expect(db._mocks.where).toHaveBeenCalledTimes(7);
    });

    it('returns null when the gate predicate filters out the only candidate', async () => {
      // The DB filters at SQL level; from JS perspective the mock returns no row
      // when the gate predicate excludes every candidate. The behavior we cover
      // is: caller passes a gate, we still get null cleanly (no exception).
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux'], ['gpu']);

      expect(result).toBeNull();
    });
  });

  describe('pinned host-fanout drain', () => {
    it('dequeueByPinnedAgent returns the pinned row', async () => {
      const row = makeDbRow({ id: 'pinned-1', pinned_agent_id: 'a1' });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueByPinnedAgent('a1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('pinned-1');
      expect(result!.pinnedAgentId).toBe('a1');
      expect(db._mocks.selectForUpdate).toHaveBeenCalled();
    });

    it('dequeueByPinnedAgent returns null when nothing is pinned to the agent', async () => {
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      expect(await queue.dequeueByPinnedAgent('a1')).toBeNull();
    });

    it('rowToQueuedJob surfaces pinnedAgentId', async () => {
      const row = makeDbRow({ pinned_agent_id: 'a2' });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['linux', 'docker'], [], 'a2');
      expect(result!.pinnedAgentId).toBe('a2');
    });
  });

  describe('dequeueForLabels two-pass pattern drain', () => {
    const boxPattern = { kind: 'regex' as const, source: '^kici:host:box-', flags: '' };
    const canaryExclude = { kind: 'regex' as const, source: '-canary$', flags: '' };

    it('pattern-free jobs still drain via the fast path', async () => {
      // Fast path hit: executeTakeFirst returns a pattern-free row.
      const row = makeDbRow({ id: 'plain', runs_on_labels: ['role:web'] });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueForLabels(['role:web']);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('plain');
      // Fast path satisfied: the batch .execute() (pattern path) never ran.
      expect(db._mocks.execute).not.toHaveBeenCalled();
    });

    it('drains a pure-regex job only to an agent whose label matches', async () => {
      const row = makeDbRow({
        id: 'regex-job',
        runs_on_labels: [],
        runs_on_patterns: [boxPattern],
      });
      // Fast path misses (no pattern-free row); pattern batch returns the row;
      // the conditional claim succeeds (numUpdatedRows = 1).
      const db = createMockDb({
        selectFirstRow: undefined,
        selectRows: [row],
        updateResult: { numUpdatedRows: 1n },
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const matched = await queue.dequeueForLabels(['kici:host:box-02']);
      expect(matched).not.toBeNull();
      expect(matched!.id).toBe('regex-job');
    });

    it('rejects a pure-regex job for an agent whose label does not match', async () => {
      const row = makeDbRow({
        id: 'regex-job',
        runs_on_labels: [],
        runs_on_patterns: [boxPattern],
      });
      const db = createMockDb({
        selectFirstRow: undefined,
        selectRows: [row],
        updateResult: { numUpdatedRows: 1n },
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // web-09 does not match ^kici:host:box- → JS post-filter rejects it.
      const wrong = await queue.dequeueForLabels(['kici:host:web-09']);
      expect(wrong).toBeNull();
      // The row was filtered out in JS, so no conditional claim was attempted.
      expect(db._mocks.set).not.toHaveBeenCalled();
    });

    it('exclude pattern blocks an otherwise-matching agent', async () => {
      const row = makeDbRow({
        id: 'web-job',
        runs_on_labels: ['role:web'],
        exclude_patterns: [canaryExclude],
      });
      const db = createMockDb({
        selectFirstRow: undefined,
        selectRows: [row],
        updateResult: { numUpdatedRows: 1n },
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const blocked = await queue.dequeueForLabels(['role:web', 'kici:host:web-canary']);
      expect(blocked).toBeNull();
      expect(db._mocks.set).not.toHaveBeenCalled();
    });

    it('returns null when the conditional claim loses the race', async () => {
      const row = makeDbRow({
        id: 'regex-job',
        runs_on_labels: [],
        runs_on_patterns: [boxPattern],
      });
      // JS filter passes, but another agent won the claim (numUpdatedRows = 0).
      const db = createMockDb({
        selectFirstRow: undefined,
        selectRows: [row],
        updateResult: { numUpdatedRows: 0n },
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const lost = await queue.dequeueForLabels(['kici:host:box-02']);
      expect(lost).toBeNull();
      expect(db._mocks.set).toHaveBeenCalled();
    });

    it('dequeueById JS-post-filters a job whose pattern the agent fails', async () => {
      const row = makeDbRow({
        id: 'bound-regex',
        runs_on_labels: [],
        runs_on_patterns: [boxPattern],
      });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // Agent label does not match ^kici:host:box- → null despite the SQL hit.
      expect(await queue.dequeueById('bound-regex', ['kici:host:web-09'])).toBeNull();
      // The right agent claims it.
      const ok = await queue.dequeueById('bound-regex', ['kici:host:box-02']);
      expect(ok?.id).toBe('bound-regex');
    });
  });

  describe('dequeueById with mandatoryLabels', () => {
    it('omits the gate predicate when agentMandatoryLabels is empty', async () => {
      const row = makeDbRow({ id: 'bound-1' });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueById('bound-1', ['linux', 'docker']);

      expect(result).not.toBeNull();
      // id-where (1) + status (2) + expiry (3) + agentLabels @> runsOn (4) + NOT EXISTS (5).
      expect(db._mocks.where).toHaveBeenCalledTimes(5);
    });

    it('adds the gate predicate when agentMandatoryLabels is non-empty', async () => {
      const row = makeDbRow({ id: 'bound-gated', runs_on_labels: ['linux', 'gpu'] });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueById('bound-gated', ['linux', 'gpu'], ['gpu']);

      expect(result).not.toBeNull();
      // 5 baseline + 1 gate predicate = 6.
      expect(db._mocks.where).toHaveBeenCalledTimes(6);
    });

    it('returns null when the gate predicate excludes the bound jobId', async () => {
      // Simulates: bound jobId still pending, but its runsOn does not include
      // the agent's gate label so the SQL filter rejects the row.
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.dequeueById('bound-x', ['linux', 'gpu'], ['gpu']);

      expect(result).toBeNull();
    });
  });

  describe('markDispatched', () => {
    it('updates job status to dispatched', async () => {
      const db = createMockDb();
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.markDispatched('job-1', 'agent-1');

      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
    });

    it('clears last_provisioning_error alongside the status flip', async () => {
      const db = createMockDb();
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.markDispatched('job-1', 'agent-1');

      // A stale spawn-failure detail from an earlier transient attempt must not
      // outlive a successful dispatch, so the column is reset to null here.
      expect(db._mocks.set).toHaveBeenCalledWith({
        status: DispatchQueueStatus.Dispatched,
        last_provisioning_error: null,
      });
    });
  });

  describe('markFailed', () => {
    it('updates job status to failed', async () => {
      const db = createMockDb();
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.markFailed('job-1', 'agent disconnected');

      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
    });
  });

  describe('requeue', () => {
    it('flips a dispatched job back to pending and returns the bumped attempt count', async () => {
      const db = createMockDb({ updateReturning: { dispatch_attempts: 1 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const attempts = await queue.requeue('job-1');

      expect(attempts).toBe(1);
      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
      // dispatched -> pending, attempt counter incremented.
      expect(db._mocks.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: DispatchQueueStatus.Pending }),
      );
    });

    it('returns null when the job is no longer dispatched', async () => {
      const db = createMockDb({ updateReturning: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const attempts = await queue.requeue('job-gone');

      expect(attempts).toBeNull();
    });

    it('clears the ack deadline columns when requeueing', async () => {
      const db = createMockDb({ updateReturning: { dispatch_attempts: 2 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.requeue('job-1');

      // A requeued job must never be swept as un-acked: both ack columns null.
      expect(db._mocks.set).toHaveBeenCalledWith(
        expect.objectContaining({ ack_deadline: null, ack_agent_id: null }),
      );
    });
  });

  describe('ack deadline', () => {
    it('setAckDeadline stamps deadline + agent only on dispatched rows', async () => {
      const db = createMockDb();
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
      const deadline = new Date('2026-06-06T10:00:00.000Z');

      await queue.setAckDeadline('job-1', deadline, 'agent-1');

      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
      expect(db._mocks.set).toHaveBeenCalledWith({
        ack_deadline: deadline,
        ack_agent_id: 'agent-1',
      });
      // Guarded to dispatched rows only.
      expect(db._mocks.updateWhere).toHaveBeenCalledWith(
        'status',
        '=',
        DispatchQueueStatus.Dispatched,
      );
    });

    it('clearAckDeadline nulls both columns', async () => {
      const db = createMockDb();
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.clearAckDeadline('job-1');

      expect(db._mocks.set).toHaveBeenCalledWith({ ack_deadline: null, ack_agent_id: null });
    });

    it('getDispatchedAwaitingAck maps rows with a non-null deadline', async () => {
      const deadline = new Date('2026-06-06T10:00:00.000Z');
      const db = createMockDb({
        selectRows: [
          { id: 'job-1', run_id: 'run-1', ack_agent_id: 'agent-1', ack_deadline: deadline },
        ],
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const rows = await queue.getDispatchedAwaitingAck();

      expect(rows).toEqual([{ id: 'job-1', runId: 'run-1', agentId: 'agent-1', deadline }]);
    });

    it('listExpiredAckDeadlines maps expired dispatched rows', async () => {
      const db = createMockDb({
        selectRows: [{ id: 'job-1', run_id: 'run-1', ack_agent_id: 'agent-1' }],
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const rows = await queue.listExpiredAckDeadlines(new Date('2026-06-06T11:00:00.000Z'));

      expect(rows).toEqual([{ id: 'job-1', runId: 'run-1', agentId: 'agent-1' }]);
    });
  });

  describe('getFullJobById', () => {
    it('returns the mapped QueuedJob for any status', async () => {
      const row = makeDbRow({ id: 'job-1', status: DispatchQueueStatus.Dispatched });
      const db = createMockDb({ selectFirstRow: row });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const job = await queue.getFullJobById('job-1');

      expect(job?.id).toBe('job-1');
      expect(job?.status).toBe(DispatchQueueStatus.Dispatched);
      expect(job?.runsOnLabels).toEqual(['linux', 'docker']);
    });

    it('returns null when the job does not exist', async () => {
      const db = createMockDb({ selectFirstRow: undefined });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      expect(await queue.getFullJobById('nope')).toBeNull();
    });
  });

  describe('markExpired', () => {
    it('returns details of expired jobs', async () => {
      const expiredRows = [
        { id: 'q-1', run_id: 'run-1', job_name: 'build' },
        { id: 'q-2', run_id: 'run-2', job_name: 'test' },
        { id: 'q-3', run_id: 'run-1', job_name: 'deploy' },
      ];
      const db = createMockDb({ selectRows: expiredRows as any });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.markExpired();

      expect(result).toHaveLength(3);
      // Rows without a recorded spawn failure surface lastProvisioningError as null.
      expect(result[0]).toEqual({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        lastProvisioningError: null,
      });
      expect(result[1]).toEqual({
        id: 'q-2',
        runId: 'run-2',
        jobName: 'test',
        lastProvisioningError: null,
      });
      expect(result[2]).toEqual({
        id: 'q-3',
        runId: 'run-1',
        jobName: 'deploy',
        lastProvisioningError: null,
      });
      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
    });

    it('returns empty array when no jobs expired', async () => {
      const db = createMockDb({ selectRows: [] });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.markExpired();

      expect(result).toEqual([]);
      // Should not call updateTable when nothing to expire
      expect(db.updateTable).not.toHaveBeenCalled();
    });

    it('surfaces last_provisioning_error in the returned info', async () => {
      const expiredRows = [
        {
          id: 'q-1',
          run_id: 'run-1',
          job_name: 'build',
          last_provisioning_error: 'spawn node ENOENT',
        },
        { id: 'q-2', run_id: 'run-2', job_name: 'test', last_provisioning_error: null },
      ];
      const db = createMockDb({ selectRows: expiredRows as any });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const result = await queue.markExpired();

      // The reaper reads the spawn-failure detail off the expired-job info.
      expect(result[0].lastProvisioningError).toBe('spawn node ENOENT');
      // Rows without a recorded failure map to null.
      expect(result[1].lastProvisioningError).toBeNull();
      // The SELECT must pull the column so the mapping has something to read.
      expect(db._mocks.execute).toHaveBeenCalled();
    });
  });

  describe('getDepth', () => {
    it('returns pending job count', async () => {
      const db = createMockDb({ countResult: { count: 7 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const depth = await queue.getDepth();

      expect(depth).toBe(7);
    });

    it('returns 0 when no pending jobs', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const depth = await queue.getDepth();

      expect(depth).toBe(0);
    });

    it('returns cached value within 1-second TTL', async () => {
      const db = createMockDb({ countResult: { count: 5 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // First call hits DB
      const depth1 = await queue.getDepth();
      expect(depth1).toBe(5);

      // Second call within 1s returns cached value (no extra DB call)
      const depth2 = await queue.getDepth();
      expect(depth2).toBe(5);
    });

    it('cache is invalidated after enqueue so rapid enqueues see fresh depth', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // Warm the cache
      await queue.getDepth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).depthCache).not.toBeNull();

      // Enqueue should invalidate the cache
      await queue.enqueue(makeJobInput());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).depthCache).toBeNull();
    });
  });

  describe('getDepthBreakdown', () => {
    it('aggregates pending + dispatched per status and fans out multi-label pending jobs', async () => {
      const db = createMockDb({
        selectRows: [
          // Pending, two labels — contributes to both.
          makeDbRow({
            id: 'a',
            status: DispatchQueueStatus.Pending,
            runs_on_labels: JSON.stringify(['linux', 'x64']),
          }),
          // Pending, one label — single contribution.
          makeDbRow({
            id: 'b',
            status: DispatchQueueStatus.Pending,
            runs_on_labels: JSON.stringify(['linux']),
          }),
          // Dispatched — counts in byStatus only, NOT byLabel.
          makeDbRow({
            id: 'c',
            status: DispatchQueueStatus.Dispatched,
            runs_on_labels: JSON.stringify(['macos']),
          }),
        ],
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const breakdown = await queue.getDepthBreakdown();

      expect(breakdown.byStatus[DispatchQueueStatus.Pending]).toBe(2);
      expect(breakdown.byStatus[DispatchQueueStatus.Dispatched]).toBe(1);
      expect(breakdown.byLabel).toEqual({ linux: 2, x64: 1 });
      // macos is dispatched-only, so it MUST NOT appear in byLabel.
      expect(breakdown.byLabel.macos).toBeUndefined();
    });

    it('returns zero-valued byStatus buckets when the queue is empty', async () => {
      const db = createMockDb({ selectRows: [] });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const breakdown = await queue.getDepthBreakdown();

      expect(breakdown.byStatus[DispatchQueueStatus.Pending]).toBe(0);
      expect(breakdown.byStatus[DispatchQueueStatus.Dispatched]).toBe(0);
      expect(breakdown.byLabel).toEqual({});
    });

    it('uses the 1-second TTL cache on back-to-back calls', async () => {
      const db = createMockDb({ selectRows: [] });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.getDepthBreakdown();
      await queue.getDepthBreakdown();

      // One underlying SELECT per distinct refresh tick.
      expect(db._mocks.execute).toHaveBeenCalledTimes(1);
    });

    it('enqueue invalidates both depthCache and breakdownCache', async () => {
      const db = createMockDb({ selectRows: [] });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.getDepthBreakdown();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).breakdownCache).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).depthCache).not.toBeNull();

      await queue.enqueue(makeJobInput());

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).breakdownCache).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((queue as any).depthCache).toBeNull();
    });

    it('readCachedDepthBreakdown returns null pre-first-call and last snapshot afterwards', async () => {
      const db = createMockDb({
        selectRows: [
          makeDbRow({
            id: 'a',
            status: DispatchQueueStatus.Pending,
            runs_on_labels: JSON.stringify(['linux']),
          }),
        ],
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      expect(queue.readCachedDepthBreakdown()).toBeNull();

      const breakdown = await queue.getDepthBreakdown();
      expect(queue.readCachedDepthBreakdown()).toBe(breakdown);
    });

    it('parses runs_on_labels returned as a native array (post-JSONB row)', async () => {
      const db = createMockDb({
        selectRows: [
          makeDbRow({
            id: 'a',
            status: DispatchQueueStatus.Pending,
            runs_on_labels: ['linux', 'arm64'],
          }),
        ],
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const breakdown = await queue.getDepthBreakdown();

      expect(breakdown.byLabel).toEqual({ linux: 1, arm64: 1 });
    });
  });

  describe('getPendingJobs', () => {
    it('returns all pending jobs in FIFO order', async () => {
      const rows = [
        makeDbRow({ id: 'job-1', created_at: '2026-02-08T10:00:00.000Z' }),
        makeDbRow({ id: 'job-2', created_at: '2026-02-08T10:01:00.000Z' }),
        makeDbRow({ id: 'job-3', created_at: '2026-02-08T10:02:00.000Z' }),
      ];
      const db = createMockDb({ selectRows: rows });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const jobs = await queue.getPendingJobs();

      expect(jobs).toHaveLength(3);
      expect(jobs[0].id).toBe('job-1');
      expect(jobs[1].id).toBe('job-2');
      expect(jobs[2].id).toBe('job-3');
    });

    it('returns empty array when no pending jobs', async () => {
      const db = createMockDb({ selectRows: [] });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const jobs = await queue.getPendingJobs();

      expect(jobs).toEqual([]);
    });

    it('correctly deserializes JSON fields', async () => {
      const rows = [
        makeDbRow({
          id: 'job-1',
          runs_on_labels: JSON.stringify(['linux', 'arm64']),
          job_config: JSON.stringify({ env: { CI: 'true' } }),
        }),
      ];
      const db = createMockDb({ selectRows: rows });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const jobs = await queue.getPendingJobs();

      expect(jobs[0].runsOnLabels).toEqual(['linux', 'arm64']);
      expect(jobs[0].jobConfig).toEqual({ env: { CI: 'true' } });
    });
  });

  describe('rowToQueuedJob conversion', () => {
    it('handles null expires_at', async () => {
      const rows = [makeDbRow({ expires_at: null })];
      const db = createMockDb({ selectRows: rows });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const jobs = await queue.getPendingJobs();

      expect(jobs[0].expiresAt).toBeNull();
    });
  });

  describe('requestId persistence', () => {
    it('enqueue persists requestId and dequeue returns it', async () => {
      const row = makeDbRow({ request_id: 'test-trace-id' });
      const db = createMockDb({
        countResult: { count: 0 },
        selectFirstRow: row,
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // Enqueue with requestId
      await queue.enqueue(makeJobInput({ requestId: 'test-trace-id' }));

      // Verify request_id was passed to DB insert
      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.request_id).toBe('test-trace-id');

      // Dequeue returns it
      const result = await queue.dequeueForLabels(['linux', 'docker']);
      expect(result).not.toBeNull();
      expect(result!.requestId).toBe('test-trace-id');
    });

    it('enqueue without requestId stores null and returns undefined', async () => {
      const row = makeDbRow({ request_id: null });
      const db = createMockDb({
        countResult: { count: 0 },
        selectFirstRow: row,
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      // Enqueue without requestId
      await queue.enqueue(makeJobInput());

      // Verify null was persisted
      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.request_id).toBeNull();

      // Dequeue returns undefined (null -> undefined mapping)
      const result = await queue.dequeueForLabels(['linux', 'docker']);
      expect(result).not.toBeNull();
      expect(result!.requestId).toBeUndefined();
    });

    it('insertDispatched persists requestId', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.insertDispatched(makeJobInput({ requestId: 'dispatch-trace' }));

      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.request_id).toBe('dispatch-trace');
    });

    it('insertDispatched without requestId stores null', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.insertDispatched(makeJobInput());

      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.request_id).toBeNull();
    });
  });

  describe('routingKey persistence', () => {
    it('enqueue persists routing_key and dequeue returns it', async () => {
      const row = makeDbRow({ routing_key: 'github:99' });
      const db = createMockDb({
        countResult: { count: 0 },
        selectFirstRow: row,
      });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.enqueue(makeJobInput({ routingKey: 'github:99' }));

      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.routing_key).toBe('github:99');

      const result = await queue.dequeueForLabels(['linux', 'docker']);
      expect(result).not.toBeNull();
      expect(result!.routingKey).toBe('github:99');
    });

    it('insertDispatched persists routing_key', async () => {
      const db = createMockDb({ countResult: { count: 0 } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.insertDispatched(makeJobInput({ routingKey: 'github:7' }));

      const valuesCall = db._mocks.values;
      const insertArg = valuesCall.mock.calls[0][0];
      expect(insertArg.routing_key).toBe('github:7');
    });
  });

  describe('failByRunId', () => {
    it('updates pending/recovering/dispatched entries to failed for a run', async () => {
      const db = createMockDb({ updateResult: { numUpdatedRows: 3n } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const count = await queue.failByRunId('run-1');

      expect(count).toBe(3);
      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
      expect(db._mocks.set).toHaveBeenCalledWith({ status: DispatchQueueStatus.Failed });
      // Status whitelist must include Dispatched so that build-coordinator
      // timeouts (which insertDispatched()'d the build job before the timer
      // fired) actually cascade to the dispatch_queue row.
      expect(db._mocks.updateWhere).toHaveBeenCalledWith('status', 'in', [
        DispatchQueueStatus.Pending,
        DispatchQueueStatus.Recovering,
        DispatchQueueStatus.Dispatched,
      ]);
    });
  });

  describe('markCompleted', () => {
    it('only updates rows in dispatched or recovering state', async () => {
      const db = createMockDb({ updateResult: { numUpdatedRows: 1n } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      await queue.markCompleted('job-1');

      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
      expect(db._mocks.set).toHaveBeenCalledWith({ status: DispatchQueueStatus.Completed });
      // Status guard must be present so a late agent job.complete cannot
      // flip a Failed/Expired row back to Completed.
      expect(db._mocks.updateWhere).toHaveBeenCalledWith('status', 'in', [
        DispatchQueueStatus.Dispatched,
        DispatchQueueStatus.Recovering,
      ]);
    });
  });

  describe('cancelByRunId', () => {
    it('updates pending entries to expired for a run', async () => {
      const db = createMockDb({ updateResult: { numUpdatedRows: 2n } });
      const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });

      const count = await queue.cancelByRunId('run-1');

      expect(count).toBe(2);
      expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
      expect(db._mocks.set).toHaveBeenCalledWith({ status: DispatchQueueStatus.Expired });
    });
  });
});
