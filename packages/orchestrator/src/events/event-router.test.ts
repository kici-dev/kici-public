/**
 * Tests for EventRouter -- internal event routing via LISTEN/NOTIFY.
 *
 * Mocks pg.Pool, Kysely, EventStore, CircuitBreaker, TrustStore to test:
 * - emit: persists event + pg_notify + returns ID
 * - circuit breaker: rejects when chain depth or rate exceeded
 * - notification handler: reads event, matches registrations, calls onEventMatched
 * - catch-up: processes unprocessed events on start
 * - cross-repo filtering: skips untrusted repos
 * - registration index: DB-backed workflow matching
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Kysely's sql tagged template to avoid needing a real DB executor for pg_notify
vi.mock('kysely', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    sql: new Proxy(actual.sql, {
      apply(_target: any, _thisArg: any, args: any[]) {
        return {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          ...args,
        };
      },
    }),
  };
});

// Mock the batch accumulator so the buffer-branch tests assert on the calls
// without needing a real DB executor for the window/item queries.
vi.mock('./batch-accumulator.js', () => ({
  openOrGetBatchWindow: vi.fn().mockResolvedValue({ windowId: 'w1', opened: true }),
  appendBatchItem: vi.fn().mockResolvedValue(undefined),
  sweepExpiredBatchWindows: vi.fn().mockResolvedValue([]),
}));

// Mock only the catch-up-failure counter, so a test can read it. Everything
// else in the module (the other event counters the router increments) is the
// real lazy instrument.
vi.mock('../metrics/prometheus.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, eventCatchUpFailuresTotal: { add: vi.fn() } };
});

import { EventRouter, type EmitEventInput, type EventRouterOptions } from './event-router.js';
import { eventCatchUpFailuresTotal } from '../metrics/prometheus.js';
import { openOrGetBatchWindow, appendBatchItem } from './batch-accumulator.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, type EventRouterConfig, type StoredEvent } from './types.js';
import { EVENT_CATCHUP_BATCH_SIZE, type EventStore } from './event-store.js';
import type { EventCircuitBreaker } from './circuit-breaker.js';
import type { TrustStore } from './trust-store.js';
import type { LockFile, LockWorkflow, WorkflowDecision } from '@kici-dev/engine';
import type { RegistrationIndex, RegisteredWorkflow } from '../registration/registration-index.js';

// ── Mock helpers ────────────────────────────────────────────────

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'evt-001',
    eventName: 'deploy-complete',
    payload: { env: 'production', version: '1.2.3' },
    sourceRepo: 'owner/repo',
    sourceRoutingKey: 'github:42',
    sourceRunId: 'run-123',
    sourceJobId: 'job-456',
    chainDepth: 0,
    processed: false,
    createdAt: new Date('2026-02-22T10:00:00Z'),
    expiresAt: new Date('2026-03-01T00:00:00Z'),
    claimedAt: null,
    claimedBy: null,
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    dlqAt: null,
    dlqReason: null,
    ...overrides,
  };
}

function makeSystemEvent(type: '__workflow_complete' | '__job_complete'): StoredEvent {
  const payload =
    type === '__workflow_complete'
      ? {
          workflowName: 'CI',
          runId: 'run-1',
          status: 'success',
          duration: 30000,
          conclusion: 'All passed',
          jobResults: [{ name: 'build', status: 'success' }],
          sourceRepo: 'owner/repo',
        }
      : {
          workflowName: 'CI',
          jobName: 'build',
          runId: 'run-1',
          jobId: 'job-1',
          status: 'success',
          duration: 15000,
          stepResults: [{ name: 'compile', status: 'success' }],
          sourceRepo: 'owner/repo',
        };

  return makeStoredEvent({
    eventName: type,
    payload,
    sourceRoutingKey: 'github:42',
  });
}

function makeLockFile(workflows: LockWorkflow[]): LockFile {
  return {
    schemaVersion: 4,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'abc123',
    workflows,
  };
}

function makeKiciEventWorkflow(name: string, eventName: string): LockWorkflow {
  return {
    name,
    contentHash: 'hash-1',
    compileSchemaVersion: 2,
    triggers: [
      {
        _type: 'kici_event' as const,
        eventName,
      },
    ],
    jobs: [],
  };
}

function makeWorkflowCompleteWorkflow(name: string, triggerName?: string): LockWorkflow {
  return {
    name,
    contentHash: 'hash-2',
    compileSchemaVersion: 2,
    triggers: [
      {
        _type: 'workflow_complete' as const,
        name: triggerName,
        status: ['success'] as readonly string[],
      },
    ],
    jobs: [],
  };
}

function makeWorkflowsFailedBatchWorkflow(name: string): LockWorkflow {
  return {
    name,
    contentHash: 'hash-3',
    compileSchemaVersion: 2,
    triggers: [
      {
        _type: 'workflows_failed_batch' as const,
        accumulateFor: 3000,
      },
    ],
    jobs: [],
  };
}

// ── Create mocks ────────────────────────────────────────────────

function createMockEventStore(options: { events?: StoredEvent[] } = {}) {
  const events = options.events ?? [];
  // Track which events have been leased to simulate atomic lease behavior.
  // Each successful lease increments attempts, mirroring the real SQL.
  const leasedIds = new Set<string>();
  const attemptsPerId = new Map<string, number>();

  return {
    write: vi.fn().mockResolvedValue('evt-new'),
    writeWith: vi.fn().mockResolvedValue('evt-new'),
    getById: vi.fn().mockImplementation((id: string) => {
      const evt = events.find((e) => e.id === id);
      return Promise.resolve(evt ?? null);
    }),
    getUnprocessedSince: vi.fn().mockResolvedValue(events),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    tryLeaseForProcessing: vi.fn().mockImplementation((id: string, leaseHolder: string) => {
      const evt = events.find((e) => e.id === id);
      if (!evt || leasedIds.has(id)) return Promise.resolve(null);
      leasedIds.add(id);
      const next = (attemptsPerId.get(id) ?? evt.attempts) + 1;
      attemptsPerId.set(id, next);
      return Promise.resolve({ ...evt, attempts: next, claimedBy: leaseHolder });
    }),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    markDlq: vi.fn().mockResolvedValue(undefined),
    findEventsDueForRetry: vi.fn().mockResolvedValue([]),
    findExpiredLeases: vi.fn().mockResolvedValue([]),
    releaseExpiredLease: vi.fn().mockResolvedValue(undefined),
    listDlq: vi.fn().mockResolvedValue([]),
    countDlq: vi.fn().mockResolvedValue(0),
    resetFromDlq: vi.fn().mockResolvedValue(true),
    deleteDlq: vi.fn().mockResolvedValue(true),
    cleanup: vi.fn().mockResolvedValue(0),
    startCleanupTimer: vi.fn(),
    stopCleanupTimer: vi.fn(),
  } as unknown as EventStore;
}

function createMockCircuitBreaker(options: { chainAllowed?: boolean; rateAllowed?: boolean } = {}) {
  const chainAllowed = options.chainAllowed ?? true;
  const rateAllowed = options.rateAllowed ?? true;
  return {
    checkChainDepth: vi.fn().mockReturnValue({
      allowed: chainAllowed,
      reason: chainAllowed ? undefined : 'Event chain depth 10 exceeds maximum 10',
    }),
    checkRateLimit: vi.fn().mockResolvedValue({
      allowed: rateAllowed,
      retryAfterMs: rateAllowed ? undefined : 5000,
    }),
    reset: vi.fn(),
  } as unknown as EventCircuitBreaker;
}

function createMockTrustStore(options: { trusted?: boolean } = {}) {
  const trusted = options.trusted ?? true;
  return {
    isTrusted: vi.fn().mockResolvedValue(trusted),
    addTrust: vi.fn().mockResolvedValue('trust-1'),
    removeTrust: vi.fn().mockResolvedValue(undefined),
    listTrust: vi.fn().mockResolvedValue([]),
  } as unknown as TrustStore;
}

function createMockPool() {
  const client = {
    on: vi.fn(),
    query: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool: pool as unknown as import('pg').Pool, client };
}

import { createMockDb as _createSharedMockDb } from '../__test-helpers__/mock-db.js';

function createMockDb() {
  const { db } = _createSharedMockDb();
  // EventRouter.emit() now wraps writeWith + pg_notify in a tx via
  // db.transaction().execute(fn). The mock just runs the callback
  // synchronously with a stub tx so the assertions on writeWith /
  // pg_notify still see the calls.
  const tx = {} as any;
  (db as any).transaction = vi.fn().mockReturnValue({
    execute: vi.fn().mockImplementation((fn: (tx: any) => Promise<unknown>) => fn(tx)),
  });
  return db;
}

function createMockRegistrationIndex(registrations: RegisteredWorkflow[] = []): RegistrationIndex {
  return {
    loadFromDb: vi.fn().mockResolvedValue(undefined),
    refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
    getVersion: vi.fn().mockReturnValue(1),
    getByTriggerType: vi.fn().mockReturnValue([]),
    getByCustomerAndRepo: vi.fn().mockReturnValue([]),
    getCronSchedules: vi.fn().mockReturnValue([]),
    getByEventType: vi.fn().mockImplementation((eventType: string) => {
      return registrations.filter((r) => r.triggerTypes.includes(eventType));
    }),
  } as unknown as RegistrationIndex;
}

function makeRegisteredWorkflow(
  name: string,
  eventName: string,
  overrides: Partial<RegisteredWorkflow> = {},
): RegisteredWorkflow {
  return {
    id: `reg-${name}`,
    repoIdentifier: 'owner/repo',
    workflowName: name,
    lockEntry: makeKiciEventWorkflow(name, eventName),
    triggerTypes: ['kici_event'],
    routingKey: 'github:42',
    providerContext: {},
    disabled: false,
    commitSha: null,
    sourceFile: null,
    ...overrides,
  };
}

function makeRegisteredWorkflowComplete(
  name: string,
  triggerWorkflowName?: string,
  overrides: Partial<RegisteredWorkflow> = {},
): RegisteredWorkflow {
  return {
    id: `reg-${name}`,
    repoIdentifier: 'owner/repo',
    workflowName: name,
    lockEntry: makeWorkflowCompleteWorkflow(name, triggerWorkflowName),
    triggerTypes: ['workflow_complete'],
    routingKey: 'github:42',
    providerContext: {},
    disabled: false,
    commitSha: null,
    sourceFile: null,
    ...overrides,
  };
}

function createRouterOptions(
  overrides: Partial<EventRouterOptions> = {},
): EventRouterOptions & { mockPool: ReturnType<typeof createMockPool> } {
  const mockPool = createMockPool();
  const config: EventRouterConfig = { ...DEFAULT_EVENT_ROUTER_CONFIG };
  return {
    db: createMockDb(),
    pool: mockPool.pool,
    eventStore: createMockEventStore(),
    circuitBreaker: createMockCircuitBreaker(),
    trustStore: createMockTrustStore(),
    config,
    onEventMatched: vi.fn().mockResolvedValue(undefined),
    registrationIndex: createMockRegistrationIndex(),
    nodeId: 'test-node-A',
    mockPool,
    ...overrides,
  };
}

/**
 * Helper: simulate a pg notification and wait for the async handler to settle.
 * The pg notification callback is fire-and-forget (.catch()), so we need
 * to flush the microtask queue to let the promise chain resolve.
 */
function simulateNotification(
  mockPool: ReturnType<typeof createMockPool>,
  channel: string,
  payload: string,
): Promise<void> {
  const notificationHandler = mockPool.client.on.mock.calls.find(
    (call: any[]) => call[0] === 'notification',
  )![1] as Function;

  notificationHandler({ channel, payload });

  // Flush microtask queue to let the fire-and-forget promise settle
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// ── Tests ────────────────────────────────────────────────────────

describe('EventRouter', () => {
  let config: EventRouterConfig;

  beforeEach(() => {
    config = { ...DEFAULT_EVENT_ROUTER_CONFIG };
  });

  describe('emit', () => {
    it('should persist event, pg_notify, and return event ID', async () => {
      const eventStore = createMockEventStore();
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      const input: EmitEventInput = {
        eventName: 'deploy-complete',
        payload: { env: 'production' },
        sourceRepo: 'owner/repo',
        sourceRoutingKey: 'github:42',
        chainDepth: 1,
      };

      const result = await router.emit(input);
      expect(result).toBe('evt-new');

      // writeWith now takes (input, tx); the test only cares about the input shape.
      expect(eventStore.writeWith).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'deploy-complete',
          payload: { env: 'production' },
          sourceRepo: 'owner/repo',
          sourceRoutingKey: 'github:42',
          chainDepth: 1,
          expiresAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('should pass targetRepos through to eventStore.writeWith', async () => {
      const eventStore = createMockEventStore();
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      const input: EmitEventInput = {
        eventName: 'deploy-complete',
        payload: { env: 'production' },
        target: { repos: ['org/repo-a', 'org/repo-b'] },
      };

      await router.emit(input);

      expect(eventStore.writeWith).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRepos: ['org/repo-a', 'org/repo-b'],
        }),
        expect.anything(),
      );
    });

    it('should not set targetRepos when target.repos is empty', async () => {
      const eventStore = createMockEventStore();
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.emit({
        eventName: 'test',
        payload: {},
        target: { repos: [] },
      });

      expect(eventStore.writeWith).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRepos: undefined,
        }),
        expect.anything(),
      );
    });

    it('should default chainDepth to 0 when not provided', async () => {
      const eventStore = createMockEventStore();
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.emit({ eventName: 'test', payload: {} });

      expect(eventStore.writeWith).toHaveBeenCalledWith(
        expect.objectContaining({ chainDepth: 0 }),
        expect.anything(),
      );
    });

    it('should reject when chain depth exceeds limit', async () => {
      const circuitBreaker = createMockCircuitBreaker({ chainAllowed: false });
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      await expect(router.emit({ eventName: 'test', payload: {}, chainDepth: 10 })).rejects.toThrow(
        'Circuit breaker tripped',
      );
    });

    it('should reject when rate limit exceeded', async () => {
      const circuitBreaker = createMockCircuitBreaker({ rateAllowed: false });
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      // A user event (no `__` prefix) is keyed `unknown:spam-event` and still
      // throws when the breaker rejects.
      await expect(router.emit({ eventName: 'spam-event', payload: {} })).rejects.toThrow(
        'Rate limit exceeded',
      );
    });

    it('exempts system events from the rate limit', async () => {
      const circuitBreaker = createMockCircuitBreaker({ rateAllowed: false });
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      // Even though the breaker would reject, a __-prefixed system event must
      // neither throw nor consult the rate limiter -- so >100 completions/min
      // across the cluster never collapse into one global bucket.
      await expect(
        router.emit({
          eventName: '__workflow_complete',
          payload: {},
          sourceRoutingKey: 'rk1',
          chainDepth: 0,
        }),
      ).resolves.toBeDefined();
      expect(circuitBreaker.checkRateLimit).not.toHaveBeenCalled();
    });

    it('exempts kici.-prefixed scaler events from the rate limit', async () => {
      const circuitBreaker = createMockCircuitBreaker({ rateAllowed: false });
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      // A burst of scale-up events from one source must all route: real scaling
      // demand cannot be dropped by the per-source 100/min event-storm bucket.
      for (let i = 0; i < 200; i++) {
        await expect(
          router.emit({
            eventName: 'kici.scaler.scale-up',
            payload: { agentId: `a-${i}` },
            sourceRoutingKey: 'rk1',
            target: { repos: ['org/infra'] },
            chainDepth: 0,
          }),
        ).resolves.toBeDefined();
      }
      expect(circuitBreaker.checkRateLimit).not.toHaveBeenCalled();
    });

    it('does not globally cap system completions across distinct workflows', async () => {
      // The bug: >100 workflow completions/min sharing the constant event name
      // `__workflow_complete` used to exhaust one global 100/min bucket and
      // silently drop the rest. Emit 150 completions across distinct
      // workflows/sources; every one must emit and none may consult the limiter.
      const circuitBreaker = createMockCircuitBreaker({ rateAllowed: false });
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      for (let i = 0; i < 150; i++) {
        await expect(
          router.emit({
            eventName: '__workflow_complete',
            payload: { runId: `run-${i}` },
            sourceRoutingKey: `rk-${i}`,
            chainDepth: 0,
          }),
        ).resolves.toBeDefined();
      }
      expect(circuitBreaker.checkRateLimit).not.toHaveBeenCalled();
    });

    it('rate-limits a user event keyed by source routing key + event name', async () => {
      const circuitBreaker = createMockCircuitBreaker(); // rateAllowed: true
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      await router.emit({ eventName: 'deploy-done', payload: {}, sourceRoutingKey: 'rk1' });
      expect(circuitBreaker.checkRateLimit).toHaveBeenCalledWith('rk1:deploy-done');
    });

    it('keys a user event without a routing key as unknown:<eventName>', async () => {
      const circuitBreaker = createMockCircuitBreaker();
      const opts = createRouterOptions({ circuitBreaker });
      const router = new EventRouter(opts);

      await router.emit({ eventName: 'deploy-done', payload: {} });
      expect(circuitBreaker.checkRateLimit).toHaveBeenCalledWith('unknown:deploy-done');
    });
  });

  describe('start + catch-up', () => {
    it('should LISTEN on kici_event_channel and run catch-up', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();

      // Should set up LISTEN
      expect(opts.mockPool.client.query).toHaveBeenCalledWith('LISTEN kici_event_channel');
      // Should register notification handler
      expect(opts.mockPool.client.on).toHaveBeenCalledWith('notification', expect.any(Function));
      // Should run catch-up (getUnprocessedSince called)
      expect(eventStore.getUnprocessedSince).toHaveBeenCalledWith(null, EVENT_CATCHUP_BATCH_SIZE);
    });

    it('should set up notification handler on start', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();

      // Notification handler should be registered
      expect(opts.mockPool.client.on).toHaveBeenCalledWith('notification', expect.any(Function));
    });

    it('should load registrations from DB on start', async () => {
      const mockIndex = createMockRegistrationIndex();
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
      });
      const router = new EventRouter(opts);

      await router.start();

      expect(mockIndex.loadFromDb).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should UNLISTEN and release client', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();
      await router.stop();

      expect(opts.mockPool.client.query).toHaveBeenCalledWith('UNLISTEN kici_event_channel');
      expect(opts.mockPool.client.release).toHaveBeenCalled();
    });

    it('should handle stop when not started', async () => {
      const opts = createRouterOptions();
      const router = new EventRouter(opts);

      // Should not throw
      await router.stop();
    });
  });

  describe('notification handler', () => {
    /**
     * The other half of the boot latch. A live NOTIFY arriving mid-bootstrap
     * must not lease and burn a dispatch attempt either — unlike the catch-up
     * scan this one IS awaited inline, because the handler runs off the pg
     * client's event loop and blocks nothing upstream.
     */
    it('holds a live notification until the boot latch resolves', async () => {
      const event = makeStoredEvent({ id: 'evt-live' });
      const eventStore = createMockEventStore({ events: [] });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      let releaseLatch!: () => void;
      const latch = new Promise<void>((resolve) => {
        releaseLatch = resolve;
      });
      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: createMockRegistrationIndex([
          makeRegisteredWorkflow('on-deploy', 'deploy-complete'),
        ]),
        dispatchReady: () => latch,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-live');

      // Nothing leased while the latch is closed — the event is held, not lost.
      expect(eventStore.tryLeaseForProcessing).not.toHaveBeenCalled();
      expect(onEventMatched).not.toHaveBeenCalled();

      releaseLatch();
      await router.catchUpSettled;
      // Flush the held notification's own continuation.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-live', 'test-node-A');
      expect(onEventMatched).toHaveBeenCalledTimes(1);
    });

    it('should atomically claim event and match against registrations', async () => {
      const event = makeStoredEvent({ id: 'evt-notified' });
      const eventStore = createMockEventStore({ events: [] });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-notified');

      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-notified', 'test-node-A');
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          workflows: expect.arrayContaining([expect.objectContaining({ name: 'on-deploy' })]),
        }),
        expect.arrayContaining([
          expect.objectContaining({
            workflowName: 'on-deploy',
            matched: true,
          }),
        ]),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
          providerContext: {},
        }),
      );
    });

    it('should skip if event already claimed by another node', async () => {
      const eventStore = createMockEventStore();
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(null);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const onEventMatched = vi.fn();
      const opts = createRouterOptions({ eventStore, onEventMatched });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-gone');

      expect(onEventMatched).not.toHaveBeenCalled();
    });

    it('should ignore notifications on other channels', async () => {
      const eventStore = createMockEventStore();
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'other_channel', 'some-id');

      expect(eventStore.tryLeaseForProcessing).not.toHaveBeenCalled();
    });

    it('should match system events (workflow_complete) correctly', async () => {
      const event = makeSystemEvent('__workflow_complete');
      const eventStore = createMockEventStore();
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const reg = makeRegisteredWorkflowComplete('on-ci-done', 'CI');
      const mockIndex = createMockRegistrationIndex([reg]);
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          workflows: expect.arrayContaining([expect.objectContaining({ name: 'on-ci-done' })]),
        }),
        expect.arrayContaining([
          expect.objectContaining({
            workflowName: 'on-ci-done',
            matched: true,
          }),
        ]),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
          providerContext: {},
        }),
      );
    });

    it('should atomically claim event via tryLeaseForProcessing', async () => {
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-idx-log',
        sourceRepo: 'owner/repo',
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-idx-log');

      // The lease pattern: tryLeaseForProcessing first, then markProcessed
      // after a successful dispatch (vs. the old "mark processed upfront"
      // pattern which silently lost events on dispatch failure).
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-idx-log', 'test-node-A');
      expect(eventStore.markProcessed).toHaveBeenCalledWith('evt-idx-log');
    });
  });

  describe('cross-repo trust filtering', () => {
    it('should skip untrusted cross-repo events', async () => {
      const event = makeStoredEvent({
        sourceRepo: 'other/repo',
        sourceRoutingKey: 'github:99',
      });
      const eventStore = createMockEventStore();
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete', {
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
      });
      const mockIndex = createMockRegistrationIndex([reg]);
      const trustStore = createMockTrustStore({ trusted: false });
      const onEventMatched = vi.fn();
      const opts = createRouterOptions({
        eventStore,
        trustStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(trustStore.isTrusted).toHaveBeenCalledWith(
        'other/repo',
        'github:99',
        'owner/repo',
        '',
        'deploy-complete',
      );
      expect(onEventMatched).not.toHaveBeenCalled();
    });

    it('should allow trusted cross-repo events', async () => {
      const event = makeStoredEvent({
        sourceRepo: 'other/repo',
        sourceRoutingKey: 'github:99',
      });
      const eventStore = createMockEventStore();
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete', {
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
      });
      const mockIndex = createMockRegistrationIndex([reg]);
      const trustStore = createMockTrustStore({ trusted: true });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        trustStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(onEventMatched).toHaveBeenCalled();
    });

    it('should skip trust check for same-repo events', async () => {
      const event = makeStoredEvent({
        sourceRepo: 'owner/repo',
        sourceRoutingKey: 'github:42',
      });
      const eventStore = createMockEventStore();
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete', {
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
      });
      const mockIndex = createMockRegistrationIndex([reg]);
      const trustStore = createMockTrustStore();
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        trustStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      // Trust store should NOT have been called (same repo)
      expect(trustStore.isTrusted).not.toHaveBeenCalled();
      // But event should still match
      expect(onEventMatched).toHaveBeenCalled();
    });
  });

  describe('catch-up', () => {
    it('should process missed events on start', async () => {
      const missedEvents = [
        makeStoredEvent({ id: 'evt-missed-1' }),
        makeStoredEvent({ id: 'evt-missed-2' }),
      ];
      const eventStore = createMockEventStore({ events: missedEvents });

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();

      expect(eventStore.getUnprocessedSince).toHaveBeenCalledWith(null, EVENT_CATCHUP_BATCH_SIZE);
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledTimes(2);
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-missed-1', 'test-node-A');
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-missed-2', 'test-node-A');
      // onEventMatched called for each matched event
      expect(onEventMatched).toHaveBeenCalledTimes(2);
    });

    /**
     * The catch-up scan is the loaded case for the boot latch: a restart with a
     * backlog replays every missed event at once, and `start()` runs it long
     * before the dispatch dependencies exist. Without the gate a backlogged
     * event burns its dispatch attempts inside that window and reaches the DLQ,
     * which is terminal loss.
     */
    it('holds the catch-up scan until the boot latch resolves', async () => {
      const eventStore = createMockEventStore({ events: [makeStoredEvent({ id: 'evt-boot' })] });
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      let releaseLatch!: () => void;
      const latch = new Promise<void>((resolve) => {
        releaseLatch = resolve;
      });
      const router = new EventRouter(
        createRouterOptions({
          eventStore,
          onEventMatched,
          registrationIndex: createMockRegistrationIndex([reg]),
          dispatchReady: () => latch,
        }),
      );

      await router.start();
      // Yield generously: the scan would have leased by now if it were not held.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(eventStore.getUnprocessedSince).not.toHaveBeenCalled();
      expect(eventStore.tryLeaseForProcessing).not.toHaveBeenCalled();

      releaseLatch();
      await router.catchUpSettled;

      // ...and the held event is dispatched, not dropped.
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-boot', 'test-node-A');
      expect(onEventMatched).toHaveBeenCalledTimes(1);
    });

    /**
     * The gate above must never be paid for with a startup deadlock. In
     * production NOTHING resolves the latch until the composition root
     * continues past `await eventRouter.start()` — so a `start()` that awaited
     * the scan would wait on a resolve that is downstream of the wait, and the
     * orchestrator would hang on every boot in every mode.
     *
     * Asserted with a bounded race rather than a plain await, so a future
     * reordering FAILS here instead of hanging CI forever.
     */
    it('completes start() while the boot latch is still unresolved', async () => {
      const eventStore = createMockEventStore({ events: [makeStoredEvent({ id: 'evt-boot' })] });
      const router = new EventRouter(
        createRouterOptions({
          eventStore,
          registrationIndex: createMockRegistrationIndex([
            makeRegisteredWorkflow('on-deploy', 'deploy-complete'),
          ]),
          // Never resolves: reproduces the production ordering, where the
          // resolver runs only after this call returns.
          dispatchReady: () => new Promise<void>(() => {}),
        }),
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlock = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('start() did not settle: boot deadlock')), 2000);
      });
      try {
        await expect(Promise.race([router.start(), deadlock])).resolves.toBeUndefined();
      } finally {
        clearTimeout(timer);
      }

      // LISTEN is registered before the scan is scheduled, so no live
      // notification is missed while the scan waits behind the latch.
      expect(eventStore.getUnprocessedSince).not.toHaveBeenCalled();
    });

    /**
     * `stopped` is a latch of its own: `stop()` sets it so a boot latch that
     * resolves after shutdown does not start a scan. Never clearing it made
     * every start AFTER a stop skip its catch-up silently — and recovering the
     * backlog a stop left behind is the scan's whole job.
     *
     * The first cycle is the positive control: same router, same harness, and
     * the scan runs. So a second cycle that does not run one is the flag, not
     * the fixture.
     */
    it('runs the catch-up again after a stop -> start cycle', async () => {
      const eventStore = createMockEventStore({ events: [makeStoredEvent({ id: 'evt-cycle' })] });
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const opts = createRouterOptions({
        eventStore,
        registrationIndex: createMockRegistrationIndex([reg]),
        dispatchReady: () => Promise.resolve(),
      });
      const router = new EventRouter(opts);

      await router.start();
      await router.catchUpSettled;
      expect(eventStore.getUnprocessedSince).toHaveBeenCalled();

      await router.stop();
      // The precondition the fix must clear is genuinely present: `stop()` set
      // the flag, and a `start()` that left it set skips the scan below.
      expect((router as unknown as { stopped: boolean }).stopped).toBe(true);
      (eventStore.getUnprocessedSince as any).mockClear();
      // The store still holds the event, so a scan that runs will find it.
      (eventStore.getUnprocessedSince as any)
        .mockResolvedValueOnce([makeStoredEvent({ id: 'evt-cycle-2' })])
        .mockResolvedValue([]);

      await router.start();
      await router.catchUpSettled;

      expect(eventStore.getUnprocessedSince).toHaveBeenCalled();
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-cycle-2', 'test-node-A');
    });

    /**
     * `stop()` tears out the pg client the scan's dispatches ride on, so it
     * must not run while a scan is mid-flight. It waits on the SCAN, never on
     * the latch-then-scan chain: in production the latch resolves only past
     * `start()`, so a bootstrap that fails in between leaves it pending forever
     * and awaiting the chain would hang shutdown instead of bounding it.
     */
    it('waits for a running catch-up scan before releasing the client', async () => {
      let releaseScan!: () => void;
      const scanGate = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      const eventStore = createMockEventStore({ events: [] });
      let scanStarted = false;
      let scanFinished = false;
      (eventStore.getUnprocessedSince as any).mockImplementation(async () => {
        scanStarted = true;
        await scanGate;
        scanFinished = true;
        return [];
      });
      const opts = createRouterOptions({
        eventStore,
        dispatchReady: () => Promise.resolve(),
      });
      const router = new EventRouter(opts);

      await router.start();
      // Let the latch resolve and the scan begin, then hold it there.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(scanStarted).toBe(true);
      expect(scanFinished).toBe(false);

      const stopping = router.stop();
      // The positive control: while the scan is held, `stop()` has not
      // released the client. A `stop()` that ignored the scan would be done by
      // now.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(opts.mockPool.client.release).not.toHaveBeenCalled();

      releaseScan();
      await stopping;

      expect(scanFinished).toBe(true);
      expect(opts.mockPool.client.release).toHaveBeenCalled();
    });

    /**
     * The mirror image: `stop()` must NOT wait on a latch that never resolves.
     * A bootstrap that throws between `start()` and the composition root's
     * resolve leaves the chain pending for the life of the process, and a
     * `stop()` that awaited it would hang the shutdown it was called to perform.
     */
    it('does not hang when the boot latch never resolves', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({
        eventStore,
        dispatchReady: () => new Promise<void>(() => {}),
      });
      const router = new EventRouter(opts);

      await router.start();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlock = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stop() did not settle')), 2000);
      });
      try {
        await expect(Promise.race([router.stop(), deadlock])).resolves.toBeUndefined();
      } finally {
        clearTimeout(timer);
      }
      expect(opts.mockPool.client.release).toHaveBeenCalled();
      // The control: the chain really is still pending, so `stop()` returned
      // without it rather than because it happened to have settled.
      const pending = Symbol('pending');
      await expect(Promise.race([router.catchUpSettled, Promise.resolve(pending)])).resolves.toBe(
        pending,
      );
    });

    it('counts a failed deferred catch-up scan', async () => {
      const eventStore = createMockEventStore({ events: [] });
      (eventStore.getUnprocessedSince as any).mockRejectedValue(new Error('db is gone'));
      const opts = createRouterOptions({
        eventStore,
        dispatchReady: () => Promise.resolve(),
      });
      const router = new EventRouter(opts);
      const before = vi.mocked(eventCatchUpFailuresTotal.add).mock.calls.length;

      await router.start();
      // The chain swallows the rejection, so this resolves rather than throws —
      // which is exactly why the failure needs a counter of its own.
      await expect(router.catchUpSettled).resolves.toBeUndefined();

      expect(vi.mocked(eventCatchUpFailuresTotal.add).mock.calls.length).toBe(before + 1);
    });

    it('runs the catch-up inline when no boot latch is configured', async () => {
      // The unlatched shape every other caller (and every other test) uses:
      // `start()` still completes the scan before it returns.
      const eventStore = createMockEventStore({ events: [makeStoredEvent({ id: 'evt-inline' })] });
      const router = new EventRouter(
        createRouterOptions({
          eventStore,
          registrationIndex: createMockRegistrationIndex([
            makeRegisteredWorkflow('on-deploy', 'deploy-complete'),
          ]),
        }),
      );

      await router.start();

      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-inline', 'test-node-A');
      expect(router.catchUpSettled).toBeNull();
    });

    it('should handle empty catch-up gracefully', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();

      expect(eventStore.getUnprocessedSince).toHaveBeenCalled();
      expect(eventStore.tryLeaseForProcessing).not.toHaveBeenCalled();
    });

    it('should paginate and dispatch ALL missed events when more than one batch accumulated', async () => {
      const total = EVENT_CATCHUP_BATCH_SIZE * 2 + 5; // 205 — spans three pages
      const base = new Date('2026-02-22T10:00:00Z').getTime();
      const allEvents = Array.from({ length: total }, (_, i) =>
        makeStoredEvent({
          id: `evt-missed-${String(i).padStart(4, '0')}`,
          // Force same-created_at ties across the 100/200 page boundaries so the
          // composite cursor is genuinely exercised (many events per timestamp).
          createdAt: new Date(base + Math.floor(i / 50) * 60_000),
        }),
      );

      const eventStore = createMockEventStore({ events: allEvents });
      // Real keyset pagination: return the page strictly after `sinceId`,
      // ordered by (createdAt, id), capped at `limit`. allEvents is already in
      // (createdAt, id) order by construction.
      (eventStore.getUnprocessedSince as any).mockImplementation(
        (sinceId: string | null, limit: number) => {
          const start = sinceId === null ? 0 : allEvents.findIndex((e) => e.id === sinceId) + 1;
          return Promise.resolve(allEvents.slice(start, start + limit));
        },
      );

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      await router.start();

      // Every one of the 205 events was leased and dispatched — nothing stranded.
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledTimes(total);
      expect(eventStore.markProcessed).toHaveBeenCalledTimes(total);
      expect(onEventMatched).toHaveBeenCalledTimes(total);
      // First and last events both came through.
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith(
        'evt-missed-0000',
        'test-node-A',
      );
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith(
        `evt-missed-${String(total - 1).padStart(4, '0')}`,
        'test-node-A',
      );
      // At least three fetches: two full pages + a short final page.
      expect((eventStore.getUnprocessedSince as any).mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('registrationIndex path', () => {
    it('should match events against DB-loaded registrations via index', async () => {
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-idx-1',
        sourceRepo: 'owner/repo', // Same repo as registration
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-idx-1');

      // Verify onEventMatched called via registration index path
      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          workflows: expect.arrayContaining([expect.objectContaining({ name: 'on-deploy' })]),
        }),
        expect.arrayContaining([
          expect.objectContaining({
            workflowName: 'on-deploy',
            matched: true,
          }),
        ]),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
          providerContext: {},
        }),
      );
    });

    it('should match __schedule_fire events via index (maps to schedule trigger type)', async () => {
      const reg: RegisteredWorkflow = {
        id: 'reg-sched-1',
        repoIdentifier: 'owner/repo',
        workflowName: 'hourly-cron',
        lockEntry: {
          name: 'hourly-cron',
          contentHash: 'hash-sched',
          compileSchemaVersion: 2,
          triggers: [
            {
              _type: 'schedule' as const,
              cronExpression: '0 * * * *',
              timezone: 'UTC',
            },
          ],
          jobs: [],
        },
        triggerTypes: ['schedule'],
        routingKey: 'github:42',
        providerContext: {},
        disabled: false,
        commitSha: null,
        sourceFile: null,
      };
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-sched-1',
        eventName: '__schedule_fire',
        payload: {
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          registrationId: 'reg-sched-1',
          workflowName: 'hourly-cron',
          repoIdentifier: 'owner/repo',
          scheduledAt: '2026-03-15T04:00:00.000Z',
        },
        sourceRepo: 'owner/repo',
        sourceRoutingKey: undefined,
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          workflows: expect.arrayContaining([expect.objectContaining({ name: 'hourly-cron' })]),
        }),
        expect.arrayContaining([
          expect.objectContaining({
            workflowName: 'hourly-cron',
            matched: true,
          }),
        ]),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
          providerContext: {},
        }),
      );
    });

    it('should only match the targeted registration for __schedule_fire (no N² duplication)', async () => {
      // Two schedule registrations exist, but the cron scheduler targets only one
      const reg1: RegisteredWorkflow = {
        id: 'reg-sched-1',
        repoIdentifier: 'owner/repo',
        workflowName: 'hourly-cron',
        lockEntry: {
          name: 'hourly-cron',
          contentHash: 'hash-sched-1',
          compileSchemaVersion: 2,
          triggers: [{ _type: 'schedule' as const, cronExpression: '0 * * * *', timezone: 'UTC' }],
          jobs: [],
        },
        triggerTypes: ['schedule'],
        routingKey: 'github:42',
        providerContext: {},
        disabled: false,
        commitSha: null,
        sourceFile: null,
      };
      const reg2: RegisteredWorkflow = {
        id: 'reg-sched-2',
        repoIdentifier: 'other/repo',
        workflowName: 'hourly-cron',
        lockEntry: {
          name: 'hourly-cron',
          contentHash: 'hash-sched-2',
          compileSchemaVersion: 2,
          triggers: [{ _type: 'schedule' as const, cronExpression: '0 * * * *', timezone: 'UTC' }],
          jobs: [],
        },
        triggerTypes: ['schedule'],
        routingKey: 'generic:e2e',
        providerContext: {},
        disabled: false,
        commitSha: null,
        sourceFile: null,
      };

      const mockIndex = createMockRegistrationIndex([reg1, reg2]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      // Event targets reg-sched-1 only
      const event = makeStoredEvent({
        id: 'evt-sched-dedup',
        eventName: '__schedule_fire',
        payload: {
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          registrationId: 'reg-sched-1',
          workflowName: 'hourly-cron',
          repoIdentifier: 'owner/repo',
          scheduledAt: '2026-03-15T04:00:00.000Z',
        },
        sourceRepo: 'owner/repo',
        sourceRoutingKey: undefined,
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      // Should only match reg-sched-1, NOT reg-sched-2
      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
        }),
      );
    });

    it('should match system events (__workflow_complete) via index', async () => {
      const reg = makeRegisteredWorkflowComplete('on-ci-done', 'CI');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeSystemEvent('__workflow_complete');
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          workflows: expect.arrayContaining([expect.objectContaining({ name: 'on-ci-done' })]),
        }),
        expect.arrayContaining([
          expect.objectContaining({
            workflowName: 'on-ci-done',
            matched: true,
          }),
        ]),
        expect.objectContaining({
          routingKey: 'github:42',
          repoIdentifier: 'owner/repo',
          providerContext: {},
        }),
      );
    });

    it('should filter registrations by targetRepos when set', async () => {
      // Two registrations for different repos, but event targets only one
      const reg1 = makeRegisteredWorkflow('on-deploy-a', 'deploy-complete', {
        repoIdentifier: 'org/repo-a',
      });
      const reg2 = makeRegisteredWorkflow('on-deploy-b', 'deploy-complete', {
        repoIdentifier: 'org/repo-b',
      });
      const mockIndex = createMockRegistrationIndex([reg1, reg2]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-target-1',
        sourceRepo: 'org/repo-a',
        targetRepos: ['org/repo-b'], // Only target repo-b
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-target-1');

      // Should only match reg2 (org/repo-b), not reg1 (org/repo-a)
      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(onEventMatched).toHaveBeenCalledWith(
        event,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ repoIdentifier: 'org/repo-b' }),
      );
    });

    it('should deliver to no registrations when targetRepos matches none', async () => {
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete', {
        repoIdentifier: 'org/repo-a',
      });
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-target-miss',
        targetRepos: ['org/repo-c'], // No registration for this repo
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-target-miss');

      expect(onEventMatched).not.toHaveBeenCalled();
    });

    it('should deliver to all registrations when targetRepos is not set', async () => {
      const reg1 = makeRegisteredWorkflow('on-deploy-a', 'deploy-complete', {
        repoIdentifier: 'org/repo-a',
      });
      const reg2 = makeRegisteredWorkflow('on-deploy-b', 'deploy-complete', {
        repoIdentifier: 'org/repo-b',
      });
      const mockIndex = createMockRegistrationIndex([reg1, reg2]);
      const eventStore = createMockEventStore({ events: [] });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({
        id: 'evt-no-target',
        sourceRepo: 'org/repo-a',
        // No targetRepos -- should deliver to all
      });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-no-target');

      expect(onEventMatched).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure handling (lease + retry + DLQ)', () => {
    it('should record a dispatch failure and schedule a retry when onEventMatched throws (under maxAttempts)', async () => {
      // Single registration; onEventMatched always throws. First lease has
      // attempts=1, far below the default maxDispatchAttempts (5), so the
      // failure should land in `recordDispatchFailure` (not `markDlq`).
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockRejectedValue(new Error('Transient DB error'));

      const event = makeStoredEvent({ id: 'evt-retry', attempts: 1 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-retry');

      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(eventStore.recordDispatchFailure).toHaveBeenCalledWith(
        'evt-retry',
        expect.stringContaining('Transient DB error'),
        expect.any(Date),
      );
      expect(eventStore.markDlq).not.toHaveBeenCalled();
      expect(eventStore.markProcessed).not.toHaveBeenCalled();
    });

    it('should move an event to the DLQ once attempts >= maxDispatchAttempts', async () => {
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockRejectedValue(new Error('permanent'));

      // attempts=5 matches the default maxDispatchAttempts; the dispatcher
      // should mark DLQ instead of scheduling another retry.
      const event = makeStoredEvent({ id: 'evt-dlq', attempts: 5 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-dlq');

      expect(eventStore.markDlq).toHaveBeenCalledWith(
        'evt-dlq',
        'exhausted_retries',
        expect.stringContaining('permanent'),
      );
      expect(eventStore.recordDispatchFailure).not.toHaveBeenCalled();
      expect(eventStore.markProcessed).not.toHaveBeenCalled();
    });

    it('should mark the event processed on a successful dispatch', async () => {
      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({ id: 'evt-ok', attempts: 1 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-ok');

      expect(eventStore.markProcessed).toHaveBeenCalledWith('evt-ok');
      expect(eventStore.recordDispatchFailure).not.toHaveBeenCalled();
      expect(eventStore.markDlq).not.toHaveBeenCalled();
    });

    it('should schedule a retry during catch-up when dispatch throws (instead of swallowing)', async () => {
      const events = [makeStoredEvent({ id: 'evt-catchup-1', attempts: 1 })];
      const eventStore = createMockEventStore({ events });

      const reg = makeRegisteredWorkflow('on-deploy', 'deploy-complete');
      const mockIndex = createMockRegistrationIndex([reg]);

      const onEventMatched = vi.fn().mockRejectedValue(new Error('Failed to process'));

      const opts = createRouterOptions({
        eventStore,
        onEventMatched,
        registrationIndex: mockIndex,
      });
      const router = new EventRouter(opts);

      // start() includes catch-up -- should NOT throw, and the failed dispatch
      // should land in `recordDispatchFailure` so the leader scanner retries it.
      await router.start();

      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-catchup-1', 'test-node-A');
      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(eventStore.recordDispatchFailure).toHaveBeenCalledWith(
        'evt-catchup-1',
        expect.stringContaining('Failed to process'),
        expect.any(Date),
      );
    });
  });

  describe('fault injection (debugFailFirstNAttemptsByEvent)', () => {
    it('throws a synthetic error when attempts <= configured budget', async () => {
      const reg = makeRegisteredWorkflow('on-test', 'test.fault');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({ id: 'evt-fi-1', eventName: 'test.fault', attempts: 1 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
        config: {
          ...DEFAULT_EVENT_ROUTER_CONFIG,
          debugFailFirstNAttemptsByEvent: { 'test.fault': 1 },
        },
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-fi-1');

      // Real dispatch should NOT have been invoked.
      expect(onEventMatched).not.toHaveBeenCalled();
      // The synthetic error should have driven the retry path (attempts=1 <
      // maxDispatchAttempts default 5).
      expect(eventStore.recordDispatchFailure).toHaveBeenCalledWith(
        'evt-fi-1',
        expect.stringContaining('fault-injection: debug-fail-first-n'),
        expect.any(Date),
      );
      expect(eventStore.markProcessed).not.toHaveBeenCalled();
    });

    it('lets dispatch through when attempts exceeds budget', async () => {
      const reg = makeRegisteredWorkflow('on-test', 'test.fault');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      // attempts=2 exceeds the budget of 1 → dispatch runs normally.
      const event = makeStoredEvent({ id: 'evt-fi-2', eventName: 'test.fault', attempts: 2 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
        config: {
          ...DEFAULT_EVENT_ROUTER_CONFIG,
          debugFailFirstNAttemptsByEvent: { 'test.fault': 1 },
        },
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-fi-2');

      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(eventStore.markProcessed).toHaveBeenCalledWith('evt-fi-2');
    });

    it('does nothing when the event name is absent from the map', async () => {
      const reg = makeRegisteredWorkflow('on-other', 'other.event');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      const event = makeStoredEvent({ id: 'evt-fi-3', eventName: 'other.event', attempts: 1 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
        config: {
          ...DEFAULT_EVENT_ROUTER_CONFIG,
          debugFailFirstNAttemptsByEvent: { 'test.fault': 1 },
        },
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-fi-3');

      // Different event name → not affected by the budget.
      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(eventStore.markProcessed).toHaveBeenCalledWith('evt-fi-3');
    });

    it('lands the event in DLQ when budget exceeds maxDispatchAttempts', async () => {
      const reg = makeRegisteredWorkflow('on-test', 'test.fault');
      const mockIndex = createMockRegistrationIndex([reg]);
      const eventStore = createMockEventStore({ events: [] });

      const onEventMatched = vi.fn().mockResolvedValue(undefined);

      // attempts=5 == maxDispatchAttempts AND attempts <= budget(99) → DLQ.
      const event = makeStoredEvent({ id: 'evt-fi-dlq', eventName: 'test.fault', attempts: 5 });
      (eventStore.tryLeaseForProcessing as any).mockResolvedValue(event);
      (eventStore.getUnprocessedSince as any).mockResolvedValue([]);

      const opts = createRouterOptions({
        registrationIndex: mockIndex,
        eventStore,
        onEventMatched,
        config: {
          ...DEFAULT_EVENT_ROUTER_CONFIG,
          debugFailFirstNAttemptsByEvent: { 'test.fault': 99 },
        },
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', 'evt-fi-dlq');

      expect(onEventMatched).not.toHaveBeenCalled();
      expect(eventStore.markDlq).toHaveBeenCalledWith(
        'evt-fi-dlq',
        'exhausted_retries',
        expect.stringContaining('fault-injection'),
      );
    });
  });

  describe('workflowsFailedBatch buffering', () => {
    beforeEach(() => {
      vi.mocked(openOrGetBatchWindow).mockClear();
      vi.mocked(appendBatchItem).mockClear();
    });

    function makeBatchReg(): RegisteredWorkflow {
      return {
        id: 'reg-notifier',
        repoIdentifier: 'owner/repo',
        workflowName: 'notifier',
        lockEntry: makeWorkflowsFailedBatchWorkflow('notifier'),
        triggerTypes: ['workflows_failed_batch'],
        routingKey: 'github:42',
        providerContext: {},
        disabled: false,
        commitSha: null,
        sourceFile: null,
      } as unknown as RegisteredWorkflow;
    }

    function makeFailedCompletionEvent(): StoredEvent {
      return makeStoredEvent({
        eventName: '__workflow_complete',
        payload: {
          workflowName: 'CI',
          runId: 'run-9',
          status: 'failed',
          sourceRepo: 'owner/repo',
          failureClass: 'step_failure',
        },
        sourceRunId: 'run-9',
        sourceRoutingKey: 'github:42',
      });
    }

    function batchRegIndex(): RegistrationIndex {
      return {
        ...createMockRegistrationIndex([]),
        getByEventType: vi.fn().mockReturnValue([makeBatchReg()]),
      } as unknown as RegistrationIndex;
    }

    it('buffers a failed workflow_complete instead of dispatching now', async () => {
      const event = makeFailedCompletionEvent();
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore: createMockEventStore({ events: [event] }),
        onEventMatched,
        registrationIndex: batchRegIndex(),
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(openOrGetBatchWindow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ registrationId: 'reg-notifier', accumulateForMs: 3000 }),
      );
      expect(appendBatchItem).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          windowId: 'w1',
          run: expect.objectContaining({ runId: 'run-9', workflowName: 'CI' }),
        }),
      );
      expect(onEventMatched).not.toHaveBeenCalled();
    });

    it('dispatches the synthetic workflows_failed_batch event to its registration', async () => {
      const event = makeStoredEvent({
        eventName: '__workflows_failed_batch',
        payload: {
          registrationId: 'reg-notifier',
          total: 3,
          runs: [{ runId: 'run-1', repo: 'owner/repo', workflowName: 'CI' }],
          sourceRepo: 'owner/repo',
        },
        sourceRoutingKey: 'github:42',
      });
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const opts = createRouterOptions({
        eventStore: createMockEventStore({ events: [event] }),
        onEventMatched,
        registrationIndex: batchRegIndex(),
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(onEventMatched).toHaveBeenCalledTimes(1);
      expect(appendBatchItem).not.toHaveBeenCalled();
    });

    it('self-excludes a failed run dispatched by a failure-lifecycle trigger', async () => {
      const event = makeFailedCompletionEvent();
      const onEventMatched = vi.fn().mockResolvedValue(undefined);
      const { db } = _createSharedMockDb({
        selectFirstRow: {
          trigger_decision: JSON.stringify({ matched: true, dispatchedByFailureLifecycle: true }),
        },
      });
      (db as any).transaction = vi.fn().mockReturnValue({
        execute: vi.fn().mockImplementation((fn: (tx: any) => Promise<unknown>) => fn({})),
      });
      const opts = createRouterOptions({
        db,
        eventStore: createMockEventStore({ events: [event] }),
        onEventMatched,
        registrationIndex: batchRegIndex(),
      });
      const router = new EventRouter(opts);

      await router.start();
      await simulateNotification(opts.mockPool, 'kici_event_channel', event.id);

      expect(appendBatchItem).not.toHaveBeenCalled();
      expect(onEventMatched).not.toHaveBeenCalled();
    });
  });

  describe('matchKiciEventSubscribers (invoke-gate summon)', () => {
    it('matches the source repo own kiciEvent subscribers', () => {
      const reg = makeRegisteredWorkflow('docker-test', 'myorg.docker-test');
      const opts = createRouterOptions({
        registrationIndex: createMockRegistrationIndex([reg]),
      });
      const router = new EventRouter(opts);

      const matches = router.matchKiciEventSubscribers('myorg.docker-test', {}, 'owner/repo');

      expect(matches).toHaveLength(1);
      expect(matches[0].reg.workflowName).toBe('docker-test');
      expect(matches[0].decisions.length).toBeGreaterThan(0);
      expect(matches[0].decisions.every((d) => d.matched)).toBe(true);
      expect(matches[0].lockFile.workflows).toHaveLength(1);
    });

    it('excludes a subscriber registered against a different repo', () => {
      const otherRepo = makeRegisteredWorkflow('docker-test', 'myorg.docker-test', {
        repoIdentifier: 'owner/other-repo',
      });
      const opts = createRouterOptions({
        registrationIndex: createMockRegistrationIndex([otherRepo]),
      });
      const router = new EventRouter(opts);

      const matches = router.matchKiciEventSubscribers('myorg.docker-test', {}, 'owner/repo');

      expect(matches).toHaveLength(0);
    });

    it('returns nothing when no workflow subscribes to the event name', () => {
      const reg = makeRegisteredWorkflow('docker-test', 'myorg.docker-test');
      const opts = createRouterOptions({
        registrationIndex: createMockRegistrationIndex([reg]),
      });
      const router = new EventRouter(opts);

      const matches = router.matchKiciEventSubscribers('myorg.node-test', {}, 'owner/repo');

      expect(matches).toHaveLength(0);
    });
  });
});
