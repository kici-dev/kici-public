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

import { EventRouter, type EmitEventInput, type EventRouterOptions } from './event-router.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, type EventRouterConfig, type StoredEvent } from './types.js';
import type { EventStore } from './event-store.js';
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
    checkRateLimit: vi.fn().mockReturnValue({
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

      await expect(router.emit({ eventName: 'spam-event', payload: {} })).rejects.toThrow(
        'Rate limit exceeded',
      );
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
      expect(eventStore.getUnprocessedSince).toHaveBeenCalledWith(null);
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

      expect(eventStore.getUnprocessedSince).toHaveBeenCalledWith(null);
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledTimes(2);
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-missed-1', 'test-node-A');
      expect(eventStore.tryLeaseForProcessing).toHaveBeenCalledWith('evt-missed-2', 'test-node-A');
      // onEventMatched called for each matched event
      expect(onEventMatched).toHaveBeenCalledTimes(2);
    });

    it('should handle empty catch-up gracefully', async () => {
      const eventStore = createMockEventStore({ events: [] });
      const opts = createRouterOptions({ eventStore });
      const router = new EventRouter(opts);

      await router.start();

      expect(eventStore.getUnprocessedSince).toHaveBeenCalled();
      expect(eventStore.tryLeaseForProcessing).not.toHaveBeenCalled();
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
});
