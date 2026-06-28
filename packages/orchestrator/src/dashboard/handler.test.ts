import { describe, it, expect, vi } from 'vitest';
import { DashboardHandler } from './handler.js';
import { groupNeedsByJobName } from './needs-edges.js';
import type {
  DashboardRunDetailRequest,
  DashboardRunsListRequest,
  DashboardRunsFiltersRequest,
  DashboardSourcesListRequest,
  DashboardStepLogsRequest,
  DashboardAttestationsListRequest,
  DashboardPayloadRequest,
  DashboardOrchLogsRequest,
  DashboardEventLogListRequest,
  DashboardEventLogDetailRequest,
  RunRerunRequest,
  RunCancelRequest,
  ManualScheduleRequest,
} from '@kici-dev/engine';
import { InitFailureCategory } from '@kici-dev/engine';
import { gzipSync } from 'node:zlib';
import { createMockDb } from '../__test-helpers__/mock-db.js';

vi.mock('@kici-dev/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

/**
 * Create a mock LogStorage.
 */
function createMockLogStorage() {
  return {
    append: vi.fn(),
    read: vi.fn().mockResolvedValue({ data: '', cursor: 0, complete: true }),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
  };
}

/** Noop action callbacks for tests that don't exercise rerun/cancel/manual-schedule. */
const noopCallbacks = {
  onRerun: vi.fn().mockRejectedValue(new Error('unexpected onRerun call')),
  onCancel: vi.fn().mockRejectedValue(new Error('unexpected onCancel call')),
  onManualSchedule: vi.fn().mockRejectedValue(new Error('unexpected onManualSchedule call')),
};

/**
 * Prepend mocks for `resolveOrgForRun` so existing tests that mock the
 * handler's own `executeTakeFirst()` queries don't have their script
 * shifted by the new lookup. The resolver issues at most three queries:
 *   1. SELECT routing_key FROM execution_runs WHERE run_id = ? LIMIT 1
 *   2. SELECT customer_id FROM sources WHERE routing_key = ? LIMIT 1
 *   3. SELECT customer_id FROM generic_webhook_sources ... LIMIT 1
 * Returning `{ routing_key: null }` from #1 short-circuits #2 / #3 — the
 * resolver returns null, the handler falls back to its bound (null/null)
 * context, and `recordAccess` is a no-op for tests that don't pass an
 * `accessLog`. This keeps these older tests passing without coupling them
 * to the new lookup chain.
 */
function mockNoopResolveOrgForRun(executeTakeFirst: ReturnType<typeof vi.fn>): void {
  executeTakeFirst.mockResolvedValueOnce({ routing_key: null });
}

describe('DashboardHandler', () => {
  describe('handleRunDetail', () => {
    it('returns jobs with nested steps', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // First execute: jobs query
      execute.mockResolvedValueOnce([
        {
          job_id: 'j1',
          job_name: 'test',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:01:00Z'),
          duration_ms: 60000,
        },
        {
          job_id: 'j2',
          job_name: 'lint',
          status: 'failed',
          matrix_values: null,
          agent_id: null,
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:00:30Z'),
          duration_ms: 30000,
        },
      ]);

      // Second execute: steps query
      execute.mockResolvedValueOnce([
        {
          job_id: 'j1',
          step_index: 0,
          step_name: 'Run tests',
          status: 'success',
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:01:00Z'),
          duration_ms: 60000,
          exit_code: 0,
          error_message: null,
        },
        {
          job_id: 'j2',
          step_index: 0,
          step_name: 'Run lint',
          status: 'failed',
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:00:30Z'),
          duration_ms: 30000,
          exit_code: 1,
          error_message: 'Lint failed',
        },
      ]);

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-1',
        runId: 'run-42',
      };

      await handler.handleRunDetail(msg);

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.requestId).toBe('req-1');
      expect(response.jobs).toHaveLength(2);

      // First job: test
      expect(response.jobs[0].jobId).toBe('j1');
      expect(response.jobs[0].jobName).toBe('test');
      expect(response.jobs[0].status).toBe('success');
      expect(response.jobs[0].matrixValues).toBeNull();
      expect(response.jobs[0].startedAt).toBe(new Date('2026-01-15T10:00:00Z').getTime());
      expect(response.jobs[0].steps).toHaveLength(1);
      expect(response.jobs[0].steps[0].stepName).toBe('Run tests');
      expect(response.jobs[0].steps[0].exitCode).toBe(0);

      // Second job: lint
      expect(response.jobs[1].jobId).toBe('j2');
      expect(response.jobs[1].steps[0].errorMessage).toBe('Lint failed');
    });

    it('handles matrix jobs with matrixValues populated', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      execute.mockResolvedValueOnce([
        {
          job_id: 'j1',
          job_name: 'test[node-18]',
          status: 'success',
          matrix_values: { node: '18' },
          agent_id: null,
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:01:00Z'),
          duration_ms: 60000,
        },
        {
          job_id: 'j2',
          job_name: 'test[node-20]',
          status: 'success',
          matrix_values: { node: '20' },
          agent_id: null,
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:01:30Z'),
          duration_ms: 90000,
        },
      ]);
      execute.mockResolvedValueOnce([]); // No steps for simplicity

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-2',
        runId: 'run-43',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.jobs[0].matrixValues).toEqual({ node: '18' });
      expect(response.jobs[1].matrixValues).toEqual({ node: '20' });
    });

    it('returns empty jobs array for run with no jobs', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      execute.mockResolvedValueOnce([]); // No jobs
      execute.mockResolvedValueOnce([]); // No steps

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-3',
        runId: 'run-empty',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.requestId).toBe('req-3');
      expect(response.jobs).toEqual([]);
      expect(response.error).toBeUndefined();
    });

    it('validates outgoing response against engine schema', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // Return a job with an invalid matrixValues type (string instead of record or null)
      // to trigger Zod schema validation failure
      execute.mockResolvedValueOnce([
        {
          job_id: 'j1',
          job_name: 'test',
          status: 'success',
          matrix_values: 'not-a-record', // pg would never return this, but tests schema validation
          agent_id: null,
          started_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:01:00Z'),
          duration_ms: 60000,
        },
      ]);
      execute.mockResolvedValueOnce([]); // No steps

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-val-fail',
        runId: 'run-bad',
      };

      // matrixValues is a string, not a record — Zod schema validation fails
      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.requestId).toBe('req-val-fail');
      // Should get error response from schema validation failure
      expect(response.error).toBeDefined();
    });

    it('sends error response on DB failure', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      execute.mockRejectedValueOnce(new Error('DB connection lost'));

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-4',
        runId: 'run-fail',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.requestId).toBe('req-4');
      expect(response.jobs).toEqual([]);
      expect(response.error).toBe('Internal error querying run detail');
    });

    it('includes run-scoped initFailure on the response when execution_runs.init_failure is populated', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // resolveOrgForRun probe — return null routing_key to short-circuit
      mockNoopResolveOrgForRun(executeTakeFirst);
      // execution_runs lookup returns init_failure
      executeTakeFirst.mockResolvedValueOnce({
        trust_tier: null,
        lock_file_source: null,
        contributor_username: null,
        init_failure: {
          scope: 'run',
          category: InitFailureCategory.enum.install_secrets,
          message: '.npmrc resolution rejected',
        },
      });
      execute.mockResolvedValueOnce([]); // jobs
      execute.mockResolvedValueOnce([]); // steps
      execute.mockResolvedValueOnce([]); // run_secret_outputs

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-init-run',
        runId: 'run-init-failure',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.initFailure).toBeDefined();
      expect(response.initFailure.scope).toBe('run');
      expect(response.initFailure.category).toBe(InitFailureCategory.enum.install_secrets);
      expect(response.error).toBeUndefined();
    });

    it('includes job-scoped initFailure on the per-job entry when execution_jobs.init_failure is populated', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // jobs query — one synthetic rejected job with init_failure
      execute.mockResolvedValueOnce([
        {
          job_id: 'rejected-deploy',
          job_name: 'deploy',
          status: 'failed',
          matrix_values: null,
          agent_id: null,
          started_at: null,
          completed_at: null,
          duration_ms: null,
          error_message: 'Rejected by protection rules',
          runs_on_labels: null,
          outputs: null,
          init_failure: {
            scope: 'job',
            category: InitFailureCategory.enum.environment_rules,
            message: 'Rejected by protection rules',
            jobName: 'deploy',
          },
        },
      ]);
      execute.mockResolvedValueOnce([]); // steps
      execute.mockResolvedValueOnce([]); // run_secret_outputs

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-init-job',
        runId: 'run-with-rejected-job',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].initFailure).toBeDefined();
      expect(response.jobs[0].initFailure.scope).toBe('job');
      expect(response.jobs[0].initFailure.category).toBe(
        InitFailureCategory.enum.environment_rules,
      );
      expect(response.error).toBeUndefined();
    });

    it('returns the bound environment list (parsed from jsonb text) on the run-detail job', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      execute.mockResolvedValueOnce([
        {
          job_id: 'job-deploy',
          job_name: 'deploy',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: null,
          completed_at: null,
          duration_ms: null,
          error_message: null,
          runs_on_labels: null,
          environments: JSON.stringify(['staging', 'my-testing']),
          outputs: null,
          init_failure: null,
        },
      ]);
      execute.mockResolvedValueOnce([]); // steps
      execute.mockResolvedValueOnce([]); // run_secret_outputs

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-env',
        runId: 'run-with-multi-env-job',
      };

      await handler.handleRunDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.detail.response');
      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].environments).toEqual(['staging', 'my-testing']);
      expect(response.error).toBeUndefined();
    });
  });

  describe('handleRunStructured', () => {
    it('sends a null result when the run is not found and records the read', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const record = vi.fn();

      // resolveOrgForRun: routing_key null short-circuits; aggregateRunDetail's
      // run-row query then returns undefined (default) → result is null.
      mockNoopResolveOrgForRun(selectExecuteTakeFirst);

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        accessLog: { record } as never,
        ...noopCallbacks,
      });

      await handler.handleRunStructured({
        type: 'dashboard.run.structured',
        requestId: 'req-s1',
        runId: 'run-missing',
        actor: { type: 'user', sub: 'u1', agent: { patId: 'p1', label: 'e2e-agent' } },
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.run.structured.response');
      expect(response.requestId).toBe('req-s1');
      expect(response.result).toBeNull();

      // The read is recorded under the agent-attributed actor.
      expect(record).toHaveBeenCalledOnce();
      const entry = record.mock.calls[0][0];
      expect(entry.action).toBe('run.structured.read');
      expect(entry.actor).toEqual({
        type: 'user',
        sub: 'u1',
        agent: { patId: 'p1', label: 'e2e-agent' },
      });
    });
  });

  describe('handleStepLogs', () => {
    it('returns log lines for a step', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);
      executeTakeFirst.mockResolvedValueOnce({
        log_path: 'executions/run-42/job-test/step-0.log',
      });

      logStorage.read.mockResolvedValueOnce({
        data: 'line 1\nline 2\nline 3\n',
        cursor: 22,
        complete: true,
      });

      const msg: DashboardStepLogsRequest = {
        type: 'dashboard.step.logs',
        requestId: 'req-5',
        runId: 'run-42',
        jobId: 'j1',
        stepIndex: 0,
      };

      await handler.handleStepLogs(msg);

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.step.logs.response');
      expect(response.requestId).toBe('req-5');
      expect(response.lines).toEqual(['line 1', 'line 2', 'line 3']);
      expect(response.totalLines).toBe(3);
      expect(response.error).toBeUndefined();

      // Verify log storage was read with correct path
      expect(logStorage.read).toHaveBeenCalledWith('executions/run-42/job-test/step-0.log');
    });

    it('returns error when step not found', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);
      executeTakeFirst.mockResolvedValueOnce(undefined);

      const msg: DashboardStepLogsRequest = {
        type: 'dashboard.step.logs',
        requestId: 'req-6',
        runId: 'run-42',
        jobId: 'j1',
        stepIndex: 99,
      };

      await handler.handleStepLogs(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.step.logs.response');
      expect(response.requestId).toBe('req-6');
      expect(response.lines).toEqual([]);
      expect(response.totalLines).toBe(0);
      expect(response.error).toBe('Step not found');
    });

    it('returns error when step has no log_path', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);
      executeTakeFirst.mockResolvedValueOnce({ log_path: null });

      const msg: DashboardStepLogsRequest = {
        type: 'dashboard.step.logs',
        requestId: 'req-7',
        runId: 'run-42',
        jobId: 'j1',
        stepIndex: 0,
      };

      await handler.handleStepLogs(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.step.logs.response');
      expect(response.requestId).toBe('req-7');
      expect(response.lines).toEqual([]);
      expect(response.totalLines).toBe(0);
      expect(response.error).toBe('No logs available');
    });

    it('validates outgoing step logs response against engine schema', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);
      executeTakeFirst.mockResolvedValueOnce({
        log_path: 'executions/run-42/job-test/step-0.log',
      });

      logStorage.read.mockResolvedValueOnce({
        data: 'line 1\nline 2\n',
        cursor: 14,
        complete: true,
      });

      const msg: DashboardStepLogsRequest = {
        type: 'dashboard.step.logs',
        requestId: 'req-val-ok',
        runId: 'run-42',
        jobId: 'j1',
        stepIndex: 0,
      };

      await handler.handleStepLogs(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.step.logs.response');
      expect(response.requestId).toBe('req-val-ok');
      // Validated data should pass through correctly
      expect(response.lines).toEqual(['line 1', 'line 2']);
      expect(response.totalLines).toBe(2);
      expect(response.error).toBeUndefined();
    });

    it('sends error response on log storage failure', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);
      executeTakeFirst.mockResolvedValueOnce({
        log_path: 'executions/run-42/job-test/step-0.log',
      });

      logStorage.read.mockRejectedValueOnce(new Error('Storage unavailable'));

      const msg: DashboardStepLogsRequest = {
        type: 'dashboard.step.logs',
        requestId: 'req-8',
        runId: 'run-42',
        jobId: 'j1',
        stepIndex: 0,
      };

      await handler.handleStepLogs(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.step.logs.response');
      expect(response.requestId).toBe('req-8');
      expect(response.lines).toEqual([]);
      expect(response.totalLines).toBe(0);
      expect(response.error).toBe('Internal error reading logs');
    });
  });

  describe('handleAttestationsList', () => {
    const validBundle = {
      mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: 'eA==',
        signatures: [{ keyid: 'k', sig: 'eA==' }],
      },
      verificationMaterial: {
        publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        identityToken: 'eyJ.a.b',
      },
    };

    function createMockProvenanceStorage(getImpl?: (key: string) => Promise<Buffer | null>) {
      return {
        get: vi.fn(getImpl ?? (async () => Buffer.from(JSON.stringify(validBundle)))),
        put: vi.fn(),
        getUploadUrl: vi.fn(),
        getInternalUploadUrl: vi.fn(),
        commit: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      } as never;
    }

    const attestationRow = {
      id: 'att-1',
      jobId: 'job-1',
      jobName: 'publish',
      subjectName: 'pkg',
      subjectDigest: 'a'.repeat(64),
      mode: 'kici',
      mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
      storageKey: 'provenance/run-42/job-1/x.kici.json',
      createdAt: new Date('2026-06-11T00:00:00.000Z'),
    };

    it('lists attestations for a run with inlined bundles', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst, selectExecute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const provenanceStorage = createMockProvenanceStorage();

      const handler = new DashboardHandler({
        db,
        logStorage,
        provenanceStorage,
        send,
        ...noopCallbacks,
      });

      mockNoopResolveOrgForRun(executeTakeFirst);
      selectExecute.mockResolvedValueOnce([attestationRow]);

      const msg: DashboardAttestationsListRequest = {
        type: 'dashboard.attestations.list',
        requestId: 'req-att-1',
        actor: { type: 'user', sub: 'u1' },
        runId: 'run-42',
      };

      await handler.handleAttestationsList(msg);

      expect(provenanceStorage.get).toHaveBeenCalledWith('provenance/run-42/job-1/x.kici.json');
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.attestations.list.response');
      expect(response.requestId).toBe('req-att-1');
      expect(response.attestations).toHaveLength(1);
      expect(response.attestations[0].jobName).toBe('publish');
      expect(response.attestations[0].bundle.mediaType).toContain('kici.provenance.bundle');
      expect(response.error).toBeUndefined();
    });

    it('returns an empty list when the run has no attestations', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst, selectExecute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const provenanceStorage = createMockProvenanceStorage();

      const handler = new DashboardHandler({
        db,
        logStorage,
        provenanceStorage,
        send,
        ...noopCallbacks,
      });

      mockNoopResolveOrgForRun(executeTakeFirst);
      selectExecute.mockResolvedValueOnce([]);

      await handler.handleAttestationsList({
        type: 'dashboard.attestations.list',
        requestId: 'req-att-empty',
        actor: { type: 'user', sub: 'u1' },
        runId: 'run-42',
      });

      const response = send.mock.calls[0][0];
      expect(response.attestations).toEqual([]);
      expect(response.error).toBeUndefined();
      expect(provenanceStorage.get).not.toHaveBeenCalled();
    });

    it('skips rows whose bundle is missing from object storage', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst, selectExecute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const provenanceStorage = createMockProvenanceStorage(async () => null);

      const handler = new DashboardHandler({
        db,
        logStorage,
        provenanceStorage,
        send,
        ...noopCallbacks,
      });

      mockNoopResolveOrgForRun(executeTakeFirst);
      selectExecute.mockResolvedValueOnce([attestationRow]);

      await handler.handleAttestationsList({
        type: 'dashboard.attestations.list',
        requestId: 'req-att-missing',
        actor: { type: 'user', sub: 'u1' },
        runId: 'run-42',
      });

      const response = send.mock.calls[0][0];
      expect(response.attestations).toEqual([]);
      expect(response.error).toBeUndefined();
    });

    it('replies with an error when provenance storage is not configured', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      mockNoopResolveOrgForRun(executeTakeFirst);

      await handler.handleAttestationsList({
        type: 'dashboard.attestations.list',
        requestId: 'req-att-noconfig',
        actor: { type: 'user', sub: 'u1' },
        runId: 'run-42',
      });

      const response = send.mock.calls[0][0];
      expect(response.attestations).toEqual([]);
      expect(response.error).toBe('Provenance storage not configured');
    });
  });

  describe('handleAttestationsListAll', () => {
    const summaryRowA = {
      id: 'att-1',
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'publish',
      subjectName: 'pkg-a',
      subjectDigest: 'sha256:' + 'a'.repeat(64),
      mode: 'kici',
      mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
      createdAt: new Date('2026-06-11T00:00:00.000Z'),
      verifyStatus: 'verified',
      verifyReason: null,
      repository: 'owner/repo',
      workflow: '.kici/workflows/release.ts',
    };
    const summaryRowB = {
      ...summaryRowA,
      id: 'att-2',
      runId: 'run-2',
      subjectName: 'pkg-b',
      verifyStatus: 'failed',
      verifyReason: 'dsse_signature_invalid',
    };

    it('returns metadata-only summaries, paginated, and access-logged', async () => {
      const {
        db,
        mocks: { selectExecute, selectExecuteTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLog = { record: vi.fn() };

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        accessLog: accessLog as never,
        ...noopCallbacks,
      });

      selectExecute.mockResolvedValueOnce([summaryRowA, summaryRowB]);
      selectExecuteTakeFirst.mockResolvedValueOnce({ count: 2 });

      await handler.handleAttestationsListAll({
        type: 'dashboard.attestations.list.all',
        requestId: 'req-all-1',
        actor: { type: 'user', sub: 'u1' },
        page: 1,
        filters: { status: 'verified' },
      });

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.attestations.list.all.response');
      expect(response.total).toBe(2);
      expect(response.pageSize).toBe(25);
      expect(response.attestations).toHaveLength(2);
      // Metadata only — never an inlined bundle on the list.
      expect(response.attestations[0]).not.toHaveProperty('bundle');
      expect(response.attestations[0].verifyStatus).toBe('verified');
      expect(response.attestations[1].verifyStatus).toBe('failed');
      expect(accessLog.record).toHaveBeenCalled();
      const logged = accessLog.record.mock.calls[0][0];
      expect(logged.target.type).toBe('attestation');
      expect(logged.action).toBe('attestations.read');
    });
  });

  describe('handleAttestationGet', () => {
    const validBundle = {
      mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: 'eA==',
        signatures: [{ keyid: 'k', sig: 'eA==' }],
      },
      verificationMaterial: {
        publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        identityToken: 'eyJ.a.b',
      },
    };
    function mockProvenanceStorage(getImpl?: (key: string) => Promise<Buffer | null>) {
      return {
        get: vi.fn(getImpl ?? (async () => Buffer.from(JSON.stringify(validBundle)))),
        put: vi.fn(),
        getUploadUrl: vi.fn(),
        getInternalUploadUrl: vi.fn(),
        commit: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      } as never;
    }
    const getRow = {
      id: 'att-1',
      runId: 'run-42',
      jobId: 'job-1',
      jobName: 'publish',
      subjectName: 'pkg',
      subjectDigest: 'a'.repeat(64),
      mode: 'kici',
      mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
      storageKey: 'provenance/run-42/job-1/x.kici.json',
      createdAt: new Date('2026-06-11T00:00:00.000Z'),
    };

    it('inlines exactly one bundle and logs against the attestation target', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const provenanceStorage = mockProvenanceStorage();

      const handler = new DashboardHandler({
        db,
        logStorage,
        provenanceStorage,
        send,
        ...noopCallbacks,
      });

      // 1) the get row, then 2) resolveOrgForRun short-circuit.
      selectExecuteTakeFirst.mockResolvedValueOnce(getRow);
      mockNoopResolveOrgForRun(selectExecuteTakeFirst);

      await handler.handleAttestationGet({
        type: 'dashboard.attestation.get',
        requestId: 'req-get-1',
        actor: { type: 'user', sub: 'u1' },
        attestationId: 'att-1',
      });

      expect(provenanceStorage.get).toHaveBeenCalledTimes(1);
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.attestation.get.response');
      expect(response.attestation.id).toBe('att-1');
      expect(response.attestation.bundle.mediaType).toContain('kici.provenance.bundle');
    });

    it('returns null attestation when the id is not found', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const provenanceStorage = mockProvenanceStorage();

      const handler = new DashboardHandler({
        db,
        logStorage,
        provenanceStorage,
        send,
        ...noopCallbacks,
      });

      selectExecuteTakeFirst.mockResolvedValueOnce(undefined);

      await handler.handleAttestationGet({
        type: 'dashboard.attestation.get',
        requestId: 'req-get-2',
        actor: { type: 'user', sub: 'u1' },
        attestationId: 'missing',
      });

      const response = send.mock.calls[0][0];
      expect(response.attestation).toBeNull();
      expect(provenanceStorage.get).not.toHaveBeenCalled();
    });
  });

  describe('handleRunsList', () => {
    /**
     * The handler now resolves the org's routing keys before the main query.
     * The mock-db routes every `.execute()` through one shared mock, so each
     * test seeds the resolution queries first (in invocation order):
     *   1. SELECT routing_key FROM sources WHERE customer_id = ? ...
     *   2. SELECT routing_key FROM generic_webhook_sources WHERE customer_id = ? ...
     * …then the `execution_runs` list query. `seedRoutingKeys(execute, gh, gen)`
     * queues the first two so the third `mockResolvedValueOnce` is the runs page.
     */
    function seedRoutingKeys(
      execute: ReturnType<typeof vi.fn>,
      ghKeys: string[],
      genKeys: string[],
    ): void {
      execute.mockResolvedValueOnce(ghKeys.map((routing_key) => ({ routing_key })));
      execute.mockResolvedValueOnce(genKeys.map((routing_key) => ({ routing_key })));
    }

    it("returns runs across ALL of the org's routing keys, newest-first and limited", async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectWhere, selectOrderBy, selectLimit },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        // Bound to the github key — but the org ALSO owns a generic key, and a
        // run came in under that sibling key. This is the regression guard for
        // the single-bound-key bug: the run under the generic key MUST appear.
        routingKey: 'github:42',
        ...noopCallbacks,
      });

      // Org owns two routing keys: one github-ish, one generic-ish.
      seedRoutingKeys(execute, ['github:42'], ['generic:org-1:src-9']);

      // execution_runs page: one run under EACH key, newest-first. Rich
      // columns (workflow_name / sha / ref / duration_ms / lineage / actors /
      // failure_reason) are populated so the enriched mapping is exercised.
      execute.mockResolvedValueOnce([
        {
          run_id: 'run-generic',
          routing_key: 'generic:org-1:src-9',
          repo_identifier: 'owner/repo',
          status: 'success',
          created_at: new Date('2026-01-15T10:00:00Z'),
          completed_at: new Date('2026-01-15T10:05:00Z'),
          provider: 'generic',
          workflow_name: 'ci',
          sha: 'abc1234',
          ref: 'main',
          started_at: new Date('2026-01-15T10:00:00Z'),
          duration_ms: 60000,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: 'user:alice@example.com',
          cancelled_by: null,
          failure_reason: null,
        },
        {
          run_id: 'run-github',
          routing_key: 'github:42',
          repo_identifier: 'owner/repo',
          status: 'running',
          created_at: new Date('2026-01-15T09:00:00Z'),
          completed_at: null,
          provider: 'github',
          workflow_name: 'deploy',
          sha: 'def5678',
          ref: 'feature',
          started_at: new Date('2026-01-15T09:00:00Z'),
          duration_ms: null,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: null,
          cancelled_by: null,
          failure_reason: null,
        },
      ]);

      // execution_jobs lookup for the page's run ids (jobCount + compile job).
      // run-generic has a compile (`__build__`) job + one real job; run-github
      // has a single real job and no compile job.
      execute.mockResolvedValueOnce([
        { run_id: 'run-generic', job_id: 'job-build-1', job_name: '__build__deploy' },
        { run_id: 'run-generic', job_id: 'job-test-1', job_name: 'test' },
        { run_id: 'run-github', job_id: 'job-test-2', job_name: 'test' },
      ]);

      const msg: DashboardRunsListRequest = {
        type: 'dashboard.runs.list',
        requestId: 'req-runs-1',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 50,
      };

      const res = await handler.handleRunsList(msg);

      expect(res.type).toBe('dashboard.runs.list.response');
      expect(res.requestId).toBe('req-runs-1');
      expect(res.error).toBeUndefined();
      expect(Array.isArray(res.runs)).toBe(true);

      const run = res.runs[0];
      expect(run).toMatchObject({
        runId: 'run-generic',
        routingKey: 'generic:org-1:src-9',
        repoIdentifier: 'owner/repo',
        status: 'success',
        createdAt: '2026-01-15T10:00:00.000Z',
        updatedAt: '2026-01-15T10:05:00.000Z',
        workflowName: 'ci',
        sha: 'abc1234',
        ref: 'main',
        durationMs: 60000,
        startedAt: '2026-01-15T10:00:00.000Z',
        completedAt: '2026-01-15T10:05:00.000Z',
        triggeredBy: 'user:alice@example.com',
        jobCount: 2,
        hadCompileJob: true,
        compileJobId: 'job-build-1',
      });
      expect(run.source).toMatchObject({
        routingKey: 'generic:org-1:src-9',
        provider: 'generic',
      });

      // The second run carries its own rich fields and no compile job.
      const run2 = res.runs[1];
      expect(run2).toMatchObject({
        runId: 'run-github',
        workflowName: 'deploy',
        sha: 'def5678',
        ref: 'feature',
        jobCount: 1,
        hadCompileJob: false,
      });
      expect(run2.compileJobId).toBeUndefined();
      expect(run2.source).toMatchObject({ routingKey: 'github:42', provider: 'github' });

      // Scoped to the UNION of the org's routing keys (not just the bound
      // one), ordered newest-first with a stable (created_at, run_id) keyset,
      // fetching limit+1 to detect "has more".
      expect(selectWhere).toHaveBeenCalledWith('routing_key', 'in', [
        'github:42',
        'generic:org-1:src-9',
      ]);
      expect(selectOrderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(selectOrderBy).toHaveBeenCalledWith('run_id', 'desc');
      expect(selectLimit).toHaveBeenCalledWith(51);
      // Two rows returned, both fit under the limit → no next page.
      expect(res.nextCursor).toBeUndefined();
    });

    it('returns an empty page (no query) when the org owns no routing keys', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectWhere },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        ...noopCallbacks,
      });

      // Both source tables resolve to zero routing keys.
      seedRoutingKeys(execute, [], []);

      const res = await handler.handleRunsList({
        type: 'dashboard.runs.list',
        requestId: 'req-runs-empty',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 50,
      });

      expect(res.type).toBe('dashboard.runs.list.response');
      expect(res.runs).toEqual([]);
      expect(res.error).toBeUndefined();
      // The main execution_runs query never ran — no routing-key filter issued.
      expect(selectWhere).not.toHaveBeenCalledWith('routing_key', 'in', expect.anything());
    });

    it('records a platform_operator access_log row with source platform_proxy', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        accessLog,
        ...noopCallbacks,
      });

      seedRoutingKeys(execute, ['github:42'], []);
      execute.mockResolvedValueOnce([]);

      const res = await handler.handleRunsList({
        type: 'dashboard.runs.list',
        requestId: 'req-runs-2',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 50,
      });

      expect(res.runs).toEqual([]);
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        orgId: 'org-1',
        routingKey: 'github:42',
        action: 'runs.list.read',
        source: 'platform_proxy',
        outcome: 'allowed',
        target: null,
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      });
    });

    it('defaults to limit 50 when none supplied and records an error row on db failure', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectLimit },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        accessLog,
        ...noopCallbacks,
      });

      // Resolution succeeds; the main execution_runs query is what fails.
      seedRoutingKeys(execute, ['github:42'], []);
      execute.mockRejectedValueOnce(new Error('db down'));

      const res = await handler.handleRunsList({
        type: 'dashboard.runs.list',
        requestId: 'req-runs-3',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      });

      // Default limit 50 → fetches limit+1 to detect "has more".
      expect(selectLimit).toHaveBeenCalledWith(51);
      expect(res.type).toBe('dashboard.runs.list.response');
      expect(res.runs).toEqual([]);
      // Wire error is the generic message — the raw 'db down' detail stays
      // server-side (logged + recorded in the access_log audit row).
      expect(res.error).toBe('Internal error querying runs list');
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'runs.list.read',
        source: 'platform_proxy',
        outcome: 'error',
        errorMessage: 'db down',
      });
    });

    it('emits a nextCursor when hitting the page limit and paginates to the end', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectLimit },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        ...noopCallbacks,
      });

      const baseRow = {
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        status: 'success',
        completed_at: null,
      };
      // limit=2 → handler fetches limit+1=3 rows; returning 3 means "has more".
      seedRoutingKeys(execute, ['github:42'], []);
      execute.mockResolvedValueOnce([
        { ...baseRow, run_id: 'run-1', created_at: new Date('2026-01-15T10:00:00Z') },
        { ...baseRow, run_id: 'run-2', created_at: new Date('2026-01-15T09:00:00Z') },
        { ...baseRow, run_id: 'run-3', created_at: new Date('2026-01-15T08:00:00Z') },
      ]);
      // execution_jobs enrichment lookup for the page rows (empty → no compile).
      execute.mockResolvedValueOnce([]);

      const firstPage = await handler.handleRunsList({
        type: 'dashboard.runs.list',
        requestId: 'req-runs-page1',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 2,
      });

      expect(selectLimit).toHaveBeenCalledWith(3);
      expect(firstPage.runs.map((r) => r.runId)).toEqual(['run-1', 'run-2']);
      expect(firstPage.nextCursor).toBeTruthy();

      // Second page: feed the cursor back; only the remaining row comes out
      // (no "extra" row → no further cursor). Routing-key resolution runs
      // again per request.
      seedRoutingKeys(execute, ['github:42'], []);
      execute.mockResolvedValueOnce([
        { ...baseRow, run_id: 'run-3', created_at: new Date('2026-01-15T08:00:00Z') },
      ]);
      // execution_jobs enrichment lookup for the page row.
      execute.mockResolvedValueOnce([]);

      const secondPage = await handler.handleRunsList({
        type: 'dashboard.runs.list',
        requestId: 'req-runs-page2',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 2,
        cursor: firstPage.nextCursor,
      });

      expect(secondPage.runs.map((r) => r.runId)).toEqual(['run-3']);
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });

  describe('handleRunsFilters', () => {
    /**
     * Same resolution-then-query script as `handleRunsList`: the handler first
     * resolves the org's routing keys (two source-table queries), then runs the
     * distinct-value scan over `execution_runs`, then resolves per-routing-key
     * source identities (two more source-table queries) for the `sources` list.
     */
    function seedRoutingKeys(
      execute: ReturnType<typeof vi.fn>,
      ghKeys: string[],
      genKeys: string[],
    ): void {
      execute.mockResolvedValueOnce(ghKeys.map((routing_key) => ({ routing_key })));
      execute.mockResolvedValueOnce(genKeys.map((routing_key) => ({ routing_key })));
    }

    it('returns distinct sorted filter options scoped to the org and records access', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectWhere },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        accessLog,
        ...noopCallbacks,
      });

      // Routing-key resolution: org owns one github key.
      seedRoutingKeys(execute, ['github:42'], []);

      // execution_runs distinct-value scan: two rows with distinct values.
      execute.mockResolvedValueOnce([
        {
          status: 'success',
          workflow_name: 'ci',
          ref: 'main',
          repo_identifier: 'o/r',
          provider: 'github',
        },
        {
          status: 'failed',
          workflow_name: 'build',
          ref: 'dev',
          repo_identifier: 'o/r2',
          provider: 'github',
        },
      ]);

      // resolveSourceIdentities: github sources lookup then generic.
      execute.mockResolvedValueOnce([
        { routing_key: 'github:42', name: 'my-repo', provider: 'github' },
      ]);
      execute.mockResolvedValueOnce([]);

      const res = await handler.handleRunsFilters({
        type: 'dashboard.runs.filters',
        requestId: 'r',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      } as never);

      expect(res.type).toBe('dashboard.runs.filters.response');
      expect(res.error).toBeUndefined();
      expect(res.workflows.slice().sort()).toEqual(['build', 'ci']);
      expect(res.statuses.slice().sort()).toEqual(['failed', 'success']);
      expect(res.branches.slice().sort()).toEqual(['dev', 'main']);
      expect(res.repositories.slice().sort()).toEqual(['o/r', 'o/r2']);
      expect(res.triggerTypes).toEqual(['github']);
      expect(res.sources).toEqual([{ routingKey: 'github:42', name: 'my-repo' }]);

      // Scoped to the union of the org's routing keys.
      expect(selectWhere).toHaveBeenCalledWith('routing_key', 'in', ['github:42']);

      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        orgId: 'org-1',
        routingKey: 'github:42',
        action: 'runs.filters.read',
        source: 'platform_proxy',
        outcome: 'allowed',
        target: null,
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      });
    });

    it('returns all-empty arrays and issues no run query when the org is unbound', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectWhere },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: null,
        routingKey: null,
        accessLog,
        ...noopCallbacks,
      });

      const res = await handler.handleRunsFilters({
        type: 'dashboard.runs.filters',
        requestId: 'r',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      } as never);

      expect(res.type).toBe('dashboard.runs.filters.response');
      expect(res.statuses).toEqual([]);
      expect(res.workflows).toEqual([]);
      expect(res.branches).toEqual([]);
      expect(res.repositories).toEqual([]);
      expect(res.triggerTypes).toEqual([]);
      expect(res.sources).toEqual([]);
      // No run query (no routing-key filter) was issued.
      expect(execute).not.toHaveBeenCalled();
      expect(selectWhere).not.toHaveBeenCalledWith('routing_key', 'in', expect.anything());
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'runs.filters.read',
        outcome: 'allowed',
      });
    });
  });

  describe('handlePayload', () => {
    it('returns parsed payload from log storage', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      const payload = { repository: { full_name: 'owner/repo' }, ref: 'refs/heads/main' };
      logStorage.read.mockResolvedValueOnce({
        data: JSON.stringify(payload),
        cursor: 100,
        complete: true,
      });

      const msg: DashboardPayloadRequest = {
        type: 'dashboard.payload',
        requestId: 'req-p1',
        runId: 'run-42',
      };

      await handler.handlePayload(msg);

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.payload.response');
      expect(response.requestId).toBe('req-p1');
      expect(response.payload).toEqual(payload);
      expect(response.error).toBeUndefined();

      expect(logStorage.read).toHaveBeenCalledWith('executions/run-42/webhook-payload.json');
    });

    it('returns error when payload not found (empty data)', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      logStorage.read.mockResolvedValueOnce({
        data: '',
        cursor: 0,
        complete: true,
      });

      const msg: DashboardPayloadRequest = {
        type: 'dashboard.payload',
        requestId: 'req-p2',
        runId: 'run-missing',
      };

      await handler.handlePayload(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.payload.response');
      expect(response.requestId).toBe('req-p2');
      expect(response.error).toBe('Payload not found');
    });

    it('returns error when payload is invalid JSON', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      logStorage.read.mockResolvedValueOnce({
        data: 'not-valid-json{',
        cursor: 15,
        complete: true,
      });

      const msg: DashboardPayloadRequest = {
        type: 'dashboard.payload',
        requestId: 'req-p3',
        runId: 'run-bad-json',
      };

      await handler.handlePayload(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.payload.response');
      expect(response.requestId).toBe('req-p3');
      expect(response.error).toBe('Payload data is not valid JSON');
    });

    it('returns error on log storage failure', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      logStorage.read.mockRejectedValueOnce(new Error('Storage down'));

      const msg: DashboardPayloadRequest = {
        type: 'dashboard.payload',
        requestId: 'req-p4',
        runId: 'run-err',
      };

      await handler.handlePayload(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.payload.response');
      expect(response.requestId).toBe('req-p4');
      expect(response.error).toBe('Internal error reading payload');
    });
  });

  describe('handleRerunRequest', () => {
    it('delegates to onRerun callback and returns newRunId', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onRerun = vi.fn().mockResolvedValue({ newRunId: 'new-run-abc' });

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks, onRerun });

      const msg: RunRerunRequest = {
        type: 'run.rerun.request',
        requestId: 'req-r1',
        actor: { type: 'user', sub: 'user@test.com' },
        runId: 'original-run-123',
      };

      await handler.handleRerunRequest(msg);

      // Phase F: third arg is `routingKey` from the WS payload; the test
      // message has no routingKey field so the callback receives `undefined`.
      expect(onRerun).toHaveBeenCalledWith('original-run-123', 'user:user@test.com', undefined);
      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.rerun.response');
      expect(response.requestId).toBe('req-r1');
      expect(response.newRunId).toBe('new-run-abc');
      expect(response.error).toBeUndefined();
    });

    it('returns error message from onRerun failure', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onRerun = vi.fn().mockRejectedValue(new Error('Run is not in a terminal state'));

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks, onRerun });

      const msg: RunRerunRequest = {
        type: 'run.rerun.request',
        requestId: 'req-r3',
        actor: { type: 'system', component: 'test' },
        runId: 'running-run',
      };

      await handler.handleRerunRequest(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.rerun.response');
      expect(response.requestId).toBe('req-r3');
      expect(response.error).toBe('Run is not in a terminal state');
      expect(response.newRunId).toBeUndefined();
    });
  });

  describe('handleCancelRequest', () => {
    it('delegates to onCancel callback and returns cancelled job count', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onCancel = vi.fn().mockResolvedValue({ cancelledJobs: 3 });

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks, onCancel });

      const msg: RunCancelRequest = {
        type: 'run.cancel.request',
        requestId: 'req-c1',
        actor: { type: 'user', sub: 'admin@company.com' },
        runId: 'run-to-cancel',
      };

      await handler.handleCancelRequest(msg);

      expect(onCancel).toHaveBeenCalledWith('run-to-cancel', 'user:admin@company.com', undefined);
      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.cancel.response');
      expect(response.requestId).toBe('req-c1');
      expect(response.cancelledJobs).toBe(3);
      expect(response.error).toBeUndefined();
    });

    it('passes force flag to onCancel callback', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onCancel = vi.fn().mockResolvedValue({ cancelledJobs: 2 });

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks, onCancel });

      const msg: RunCancelRequest = {
        type: 'run.cancel.request',
        requestId: 'req-force',
        actor: { type: 'user', sub: 'admin@company.com' },
        runId: 'run-force-cancel',
        force: true,
      };

      await handler.handleCancelRequest(msg);

      expect(onCancel).toHaveBeenCalledWith('run-force-cancel', 'user:admin@company.com', true);
      const response = send.mock.calls[0][0];
      expect(response.cancelledJobs).toBe(2);
    });

    it('returns error message from onCancel failure', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onCancel = vi.fn().mockRejectedValue(new Error('Database connection lost'));

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks, onCancel });

      const msg: RunCancelRequest = {
        type: 'run.cancel.request',
        requestId: 'req-c3',
        actor: { type: 'system', component: 'test' },
        runId: 'run-fail',
      };

      await handler.handleCancelRequest(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.cancel.response');
      expect(response.requestId).toBe('req-c3');
      expect(response.error).toBe('Database connection lost');
    });
  });

  describe('handleOrchLogs', () => {
    it('returns orchestration log lines from log storage', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      const logLine1 = JSON.stringify({ ts: 1000, phase: 'dispatch', message: 'Job dispatched' });
      const logLine2 = JSON.stringify({ ts: 2000, phase: 'setup', message: 'Agent assigned' });
      logStorage.read.mockResolvedValueOnce({
        data: `${logLine1}\n${logLine2}\n`,
        cursor: 100,
        complete: true,
      });

      const msg: DashboardOrchLogsRequest = {
        type: 'dashboard.orch.logs',
        requestId: 'req-ol1',
        runId: 'run-42',
        jobId: 'job-1',
      };

      await handler.handleOrchLogs(msg);

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.orch.logs.response');
      expect(response.requestId).toBe('req-ol1');
      expect(response.lines).toHaveLength(2);
      expect(response.totalLines).toBe(2);
      expect(response.error).toBeUndefined();

      expect(logStorage.read).toHaveBeenCalledWith(
        'executions/run-42/jobs/job-1/orchestration.jsonl',
      );
    });

    it('returns empty lines when log file does not exist', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      logStorage.read.mockRejectedValueOnce(new Error('File not found'));

      const msg: DashboardOrchLogsRequest = {
        type: 'dashboard.orch.logs',
        requestId: 'req-ol2',
        runId: 'run-old',
        jobId: 'job-1',
      };

      await handler.handleOrchLogs(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.orch.logs.response');
      expect(response.requestId).toBe('req-ol2');
      expect(response.lines).toEqual([]);
      expect(response.totalLines).toBe(0);
    });

    it('merges orchestration and provisioning log lines', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      const orchLine = JSON.stringify({ ts: 1000, phase: 'dispatch', message: 'Job dispatched' });
      const provLine = JSON.stringify({
        ts: 2000,
        phase: 'provisioning',
        eventType: 'container.started',
        message: 'Container ready',
        agentId: 'agent-1',
      });

      // First read: orchestration.jsonl
      logStorage.read.mockResolvedValueOnce({
        data: `${orchLine}\n`,
        cursor: 50,
        complete: true,
      });
      // Second read: provisioning.jsonl
      logStorage.read.mockResolvedValueOnce({
        data: `${provLine}\n`,
        cursor: 80,
        complete: true,
      });

      const msg: DashboardOrchLogsRequest = {
        type: 'dashboard.orch.logs',
        requestId: 'req-ol3',
        runId: 'run-55',
        jobId: 'job-2',
      };

      await handler.handleOrchLogs(msg);

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.orch.logs.response');
      expect(response.lines).toHaveLength(2);
      expect(response.lines[0]).toBe(orchLine);
      expect(response.lines[1]).toBe(provLine);
      expect(response.totalLines).toBe(2);

      expect(logStorage.read).toHaveBeenCalledWith(
        'executions/run-55/jobs/job-2/orchestration.jsonl',
      );
      expect(logStorage.read).toHaveBeenCalledWith(
        'executions/run-55/jobs/job-2/provisioning.jsonl',
      );
    });
  });

  describe('handleManualScheduleRequest', () => {
    it('delegates to onManualSchedule callback and returns newRunId', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onManualSchedule = vi.fn().mockResolvedValue({ newRunId: 'new-run-sched' });

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        ...noopCallbacks,
        onManualSchedule,
      });

      const msg: ManualScheduleRequest = {
        type: 'run.manual_schedule.request',
        requestId: 'req-ms1',
        actor: { type: 'user', sub: 'user@test.com' },
        registrationId: 'reg-abc',
      };

      await handler.handleManualScheduleRequest(msg);

      expect(onManualSchedule).toHaveBeenCalledWith('reg-abc', 'user:user@test.com');
      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.manual_schedule.response');
      expect(response.requestId).toBe('req-ms1');
      expect(response.newRunId).toBe('new-run-sched');
      expect(response.error).toBeUndefined();
    });

    it('returns error message from onManualSchedule failure', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const onManualSchedule = vi
        .fn()
        .mockRejectedValue(new Error('Schedule registration not found'));

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        ...noopCallbacks,
        onManualSchedule,
      });

      const msg: ManualScheduleRequest = {
        type: 'run.manual_schedule.request',
        requestId: 'req-ms2',
        actor: { type: 'system', component: 'test' },
        registrationId: 'reg-missing',
      };

      await handler.handleManualScheduleRequest(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('run.manual_schedule.response');
      expect(response.requestId).toBe('req-ms2');
      expect(response.error).toBe('Schedule registration not found');
      expect(response.newRunId).toBeUndefined();
    });
  });

  // ── event-log handlers ───────────────────────────────────────────

  describe('handleEventLogList', () => {
    it('returns rows mapped to EventLogListItem shape', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // Mock the event_log query response
      execute.mockResolvedValueOnce([
        {
          id: '00000000-0000-0000-0000-000000000001',
          delivery_id: 'd-1',
          routing_key: 'github:42',
          event: 'push',
          action: null,
          source: 'relay',
          provider: 'github',
          repo_identifier: 'example-org/example-repo',
          ref: 'refs/heads/main',
          status: 'processed',
          matched_count: 1,
          run_id: '00000000-0000-0000-0000-0000000000aa',
          error_message: null,
          received_at: new Date('2026-04-17T10:00:00Z'),
          payload_omitted: false,
          payload_omitted_reason: null,
          payload_size_bytes: 1024,
          payload_hash: 'sha256-abc',
        },
      ]);

      const msg: DashboardEventLogListRequest = {
        type: 'dashboard.event-log.list',
        requestId: 'req-el-1',
        orgId: 'org-001',
        limit: 10,
      };

      await handler.handleEventLogList(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-log.list.response');
      expect(response.requestId).toBe('req-el-1');
      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toEqual({
        deliveryId: 'd-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        source: 'relay',
        provider: 'github',
        repoIdentifier: 'example-org/example-repo',
        ref: 'refs/heads/main',
        status: 'processed',
        matchedCount: 1,
        runId: '00000000-0000-0000-0000-0000000000aa',
        errorMessage: null,
        receivedAt: '2026-04-17T10:00:00.000Z',
        payloadOmitted: false,
        payloadOmittedReason: null,
        payloadSizeBytes: 1024,
        payloadHash: 'sha256-abc',
      });
      expect(response.nextCursor).toBeNull();
    });

    it('emits a nextCursor when hitting the page limit', async () => {
      const {
        db,
        mocks: { selectExecute: execute },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // Limit=2 → handler asks for limit+1=3 rows; if we return 3 it should emit a cursor.
      const baseRow = {
        delivery_id: 'd',
        routing_key: 'github:42',
        event: 'push',
        action: null,
        source: 'direct',
        provider: 'github',
        repo_identifier: null,
        ref: null,
        status: 'processed',
        matched_count: 0,
        run_id: null,
        error_message: null,
        payload_omitted: false,
        payload_omitted_reason: null,
        payload_size_bytes: 1,
        payload_hash: 'h',
      };
      execute.mockResolvedValueOnce([
        {
          ...baseRow,
          id: 'id-1',
          delivery_id: 'd-1',
          received_at: new Date('2026-04-17T03:00:00Z'),
        },
        {
          ...baseRow,
          id: 'id-2',
          delivery_id: 'd-2',
          received_at: new Date('2026-04-17T02:00:00Z'),
        },
        {
          ...baseRow,
          id: 'id-3',
          delivery_id: 'd-3',
          received_at: new Date('2026-04-17T01:00:00Z'),
        },
      ]);

      await handler.handleEventLogList({
        type: 'dashboard.event-log.list',
        requestId: 'req-el-2',
        orgId: 'org-001',
        limit: 2,
      });

      const response = send.mock.calls[0][0];
      expect(response.items).toHaveLength(2);
      expect(response.nextCursor).toBeTruthy();
    });
  });

  describe('handleEventLogDetail', () => {
    it('returns row metadata only (payload streams separately)', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      executeTakeFirst.mockResolvedValueOnce({
        id: 'row-1',
        org_id: 'org-001',
        delivery_id: 'd-1',
        routing_key: 'github:42',
        event: 'push',
        action: null,
        source: 'relay',
        provider: 'github',
        repo_identifier: 'example-org/example-repo',
        ref: 'refs/heads/main',
        status: 'processed',
        matched_count: 1,
        run_id: null,
        error_message: null,
        received_at: new Date('2026-04-17T10:00:00Z'),
        expires_at: new Date('2026-05-17T10:00:00Z'),
        payload_key: 'event-log/org-001/d-1.json.gz',
        payload_omitted: false,
        payload_omitted_reason: null,
        payload_size_bytes: 64,
        payload_hash: 'h',
      });

      const msg: DashboardEventLogDetailRequest = {
        type: 'dashboard.event-log.detail',
        requestId: 'req-el-d-1',
        orgId: 'org-001',
        deliveryId: 'd-1',
      };

      await handler.handleEventLogDetail(msg);

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-log.detail.response');
      expect(response.requestId).toBe('req-el-d-1');
      expect(response.item.deliveryId).toBe('d-1');
      // Body bytes never travel inline anymore — the dashboard fetches them
      // via the chunked-WS path (handleEventLogPayloadStream).
      expect(response.payload).toBeUndefined();
      expect(logStorage.read).not.toHaveBeenCalled();
    });

    it('reflects payload_omitted on the row regardless of streaming', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      executeTakeFirst.mockResolvedValueOnce({
        id: 'row-1',
        org_id: 'org-001',
        delivery_id: 'd-1',
        routing_key: 'github:42',
        event: 'push',
        action: null,
        source: 'direct',
        provider: 'github',
        repo_identifier: null,
        ref: null,
        status: 'processed',
        matched_count: 0,
        run_id: null,
        error_message: null,
        received_at: new Date('2026-04-17T10:00:00Z'),
        expires_at: new Date('2026-05-17T10:00:00Z'),
        payload_key: null,
        payload_omitted: true,
        payload_omitted_reason: 'size_exceeded',
        payload_size_bytes: 999_999,
        payload_hash: 'h',
      });

      await handler.handleEventLogDetail({
        type: 'dashboard.event-log.detail',
        requestId: 'req-el-d-2',
        orgId: 'org-001',
        deliveryId: 'd-1',
      });

      const response = send.mock.calls[0][0];
      expect(response.item.payloadOmitted).toBe(true);
      expect(response.item.payloadOmittedReason).toBe('size_exceeded');
      expect(response.payload).toBeUndefined();
      expect(logStorage.read).not.toHaveBeenCalled();
    });

    it('returns Delivery not found error when row is missing', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });
      executeTakeFirst.mockResolvedValueOnce(undefined);

      await handler.handleEventLogDetail({
        type: 'dashboard.event-log.detail',
        requestId: 'req-el-d-3',
        orgId: 'org-001',
        deliveryId: 'missing',
      });

      const response = send.mock.calls[0][0];
      expect(response.error).toBe('Delivery not found');
      expect(response.item).toBeUndefined();
    });
  });

  describe('handleEventLogPayloadStream', () => {
    function makeRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'row-1',
        org_id: 'org-001',
        delivery_id: 'd-1',
        routing_key: 'github:42',
        event: 'push',
        action: null,
        source: 'relay',
        provider: 'github',
        repo_identifier: 'example-org/example-repo',
        ref: 'refs/heads/main',
        status: 'processed',
        matched_count: 1,
        run_id: null,
        error_message: null,
        received_at: new Date('2026-04-17T10:00:00Z'),
        expires_at: new Date('2026-05-17T10:00:00Z'),
        payload_key: 'event-log/org-001/d-1.json.gz',
        payload_omitted: false,
        payload_omitted_reason: null,
        payload_size_bytes: 64,
        payload_hash: 'h',
        ...overrides,
      };
    }

    it('streams a 200 KiB payload as four chunks (64 KiB + 64 + 64 + remainder)', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      // 200 KiB ASCII text — JSON-parseable as a string when concatenated.
      const totalBytes = 200 * 1024;
      const raw = 'a'.repeat(totalBytes);
      const gz = gzipSync(Buffer.from(raw, 'utf-8'));
      logStorage.read = vi.fn().mockResolvedValue({
        data: gz.toString('binary'),
        cursor: gz.byteLength,
        complete: true,
      });
      executeTakeFirst.mockResolvedValueOnce(makeRow());

      await handler.handleEventLogPayloadStream({
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-stream-1',
        actor: { type: 'user', sub: 'zsub-test' },
        orgId: 'org-001',
        deliveryId: 'd-1',
      });

      // Expect 4 chunks: 65536 + 65536 + 65536 + 3*1024 = 204800 bytes.
      expect(send).toHaveBeenCalledTimes(4);
      const chunks = send.mock.calls.map((c) => c[0]);
      expect(chunks[0].type).toBe('dashboard.event-log.payload.chunk');
      expect(chunks[0].seq).toBe(0);
      expect(chunks[0].totalBytes).toBe(totalBytes);
      expect(chunks[0].isLast).toBe(false);
      expect(chunks[3].seq).toBe(3);
      expect(chunks[3].isLast).toBe(true);
      expect(chunks[3].totalBytes).toBeUndefined();
      // Reassemble: each chunk is base64 of the slice. Total decoded length
      // must equal totalBytes and round-trip back to the source text.
      const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')));
      expect(joined.byteLength).toBe(totalBytes);
      expect(joined.toString('utf-8')).toBe(raw);
    });

    it('emits a single terminal chunk with payload_unavailable when payload_omitted=true', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      executeTakeFirst.mockResolvedValueOnce(
        makeRow({
          payload_key: null,
          payload_omitted: true,
          payload_omitted_reason: 'size_exceeded',
        }),
      );

      await handler.handleEventLogPayloadStream({
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-stream-2',
        actor: { type: 'user', sub: 'zsub-test' },
        orgId: 'org-001',
        deliveryId: 'd-1',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const chunk = send.mock.calls[0][0];
      expect(chunk.isLast).toBe(true);
      expect(chunk.error).toBe('payload_unavailable');
      expect(chunk.data).toBe('');
      expect(logStorage.read).not.toHaveBeenCalled();
    });

    it('emits a single terminal chunk with not_found when row is missing', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });
      executeTakeFirst.mockResolvedValueOnce(undefined);

      await handler.handleEventLogPayloadStream({
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-stream-3',
        actor: { type: 'user', sub: 'zsub-test' },
        orgId: 'org-001',
        deliveryId: 'missing',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const chunk = send.mock.calls[0][0];
      expect(chunk.isLast).toBe(true);
      expect(chunk.error).toBe('not_found');
    });

    it('emits a terminal read_failed chunk when LogStorage throws', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      executeTakeFirst.mockResolvedValueOnce(makeRow());
      logStorage.read = vi.fn().mockRejectedValue(new Error('s3 down'));

      await handler.handleEventLogPayloadStream({
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-stream-4',
        actor: { type: 'user', sub: 'zsub-test' },
        orgId: 'org-001',
        deliveryId: 'd-1',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const chunk = send.mock.calls[0][0];
      expect(chunk.isLast).toBe(true);
      expect(chunk.error).toBe('read_failed');
    });

    it('emits a terminal empty-body chunk for an empty (zero-byte) payload', async () => {
      const {
        db,
        mocks: { selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      const gz = gzipSync(Buffer.alloc(0));
      logStorage.read = vi.fn().mockResolvedValue({
        data: gz.toString('binary'),
        cursor: gz.byteLength,
        complete: true,
      });
      executeTakeFirst.mockResolvedValueOnce(makeRow());

      await handler.handleEventLogPayloadStream({
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-stream-5',
        actor: { type: 'user', sub: 'zsub-test' },
        orgId: 'org-001',
        deliveryId: 'd-1',
      });

      expect(send).toHaveBeenCalledTimes(1);
      const chunk = send.mock.calls[0][0];
      expect(chunk.isLast).toBe(true);
      expect(chunk.totalBytes).toBe(0);
      expect(chunk.error).toBeUndefined();
    });
  });

  // ── multi-tenant orgId resolution ───────────────────────────────
  //
  // The wishlist invariant: when the orchestrator hosts more than one
  // tenant (staging during an E2E batch), `recordAccess` MUST attribute
  // the dashboard read to the **run's** owning org / routing key — not
  // the handler-bound (LIMIT-1, no-ORDER-BY, non-deterministic) pair set
  // by `setOrgContext`. Source: wishlist `20260505_105131_orchestrator-
  // dashboard-handler-stamps-bound-orgId-not-run-owner.md`.
  describe('multi-tenant orgId resolution', () => {
    it('handleRunDetail attributes access_log to the run-owning org, not the bound org', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Bound context = "wrong-org" / "generic:wrong-org:src-foo" — mimics
      // the LIMIT-1 resolver picking the wrong tenant on a multi-tenant
      // orchestrator at boot.
      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'wrong-org',
        routingKey: 'generic:wrong-org:src-foo',
        accessLog,
        ...noopCallbacks,
      });

      // Resolver script:
      //   1. SELECT routing_key FROM execution_runs WHERE run_id = 'run-42'
      //      → returns { routing_key: 'generic:right-org:src-1' }
      //   2. SELECT customer_id FROM sources WHERE routing_key = ...
      //      → undefined (no GH-app source for this key)
      //   3. SELECT customer_id FROM generic_webhook_sources WHERE ...
      //      → returns { customer_id: 'right-org' }
      executeTakeFirst.mockResolvedValueOnce({ routing_key: 'generic:right-org:src-1' });
      executeTakeFirst.mockResolvedValueOnce(undefined);
      executeTakeFirst.mockResolvedValueOnce({ customer_id: 'right-org' });
      // 4. handleRunDetail's own trust-context lookup on execution_runs
      executeTakeFirst.mockResolvedValueOnce(undefined);
      // 5. jobs query, 6. steps query, 7. run_secret_outputs query
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);

      const msg: DashboardRunDetailRequest = {
        type: 'dashboard.run.detail',
        requestId: 'req-multi-1',
        runId: 'run-42',
        actor: { type: 'user', sub: 'tester@example.com' },
      };

      await handler.handleRunDetail(msg);

      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      const recordedEntry = accessLogRecord.mock.calls[0][0] as Record<string, unknown>;
      expect(recordedEntry.orgId).toBe('right-org');
      expect(recordedEntry.routingKey).toBe('generic:right-org:src-1');
      expect(recordedEntry.action).toBe('run.detail.read');
      expect(recordedEntry.outcome).toBe('allowed');
    });

    it('handleRunDetail falls back to bound context when the run row is missing', async () => {
      // Cold-archived run case: execution_runs lookup returns undefined,
      // resolver returns null → contextOrFallback uses the bound pair.
      const {
        db,
        mocks: { selectExecute: execute, selectExecuteTakeFirst: executeTakeFirst },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'bound-org',
        routingKey: 'generic:bound-org:src-x',
        accessLog,
        ...noopCallbacks,
      });

      // 1. resolveOrgForRun → execution_runs lookup → undefined (cold-archived)
      executeTakeFirst.mockResolvedValueOnce(undefined);
      // 2. handleRunDetail's own trust-context lookup
      executeTakeFirst.mockResolvedValueOnce(undefined);
      execute.mockResolvedValueOnce([]); // jobs
      execute.mockResolvedValueOnce([]); // steps
      execute.mockResolvedValueOnce([]); // run_secret_outputs

      await handler.handleRunDetail({
        type: 'dashboard.run.detail',
        requestId: 'req-multi-2',
        runId: 'run-archived',
        actor: { type: 'user', sub: 'tester@example.com' },
      });

      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      const recordedEntry = accessLogRecord.mock.calls[0][0] as Record<string, unknown>;
      expect(recordedEntry.orgId).toBe('bound-org');
      expect(recordedEntry.routingKey).toBe('generic:bound-org:src-x');
    });
  });

  describe('handleEventDlqList', () => {
    function makeStoredEvent(overrides: Record<string, unknown> = {}) {
      return {
        id: 'evt-1',
        eventName: 'custom.thing',
        payload: { foo: 'bar' },
        sourceRepo: 'octo/repo',
        sourceRoutingKey: 'github:42',
        sourceRunId: null,
        sourceJobId: null,
        chainDepth: 0,
        processed: false,
        createdAt: new Date('2026-04-17T10:00:00Z'),
        expiresAt: new Date('2026-04-24T10:00:00Z'),
        claimedAt: null,
        claimedBy: null,
        attempts: 5,
        lastError: 'boom',
        nextRetryAt: null,
        dlqAt: new Date('2026-04-17T11:00:00Z'),
        dlqReason: 'exhausted_retries' as const,
        ...overrides,
      };
    }

    it('returns DLQ rows mapped to the wire shape', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const eventStore = {
        listDlq: vi.fn().mockResolvedValue([makeStoredEvent()]),
        countDlq: vi.fn(),
        getById: vi.fn(),
        resetFromDlq: vi.fn(),
        deleteDlq: vi.fn(),
        getDb: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        ...noopCallbacks,
      });

      await handler.handleEventDlqList({
        type: 'dashboard.event-dlq.list',
        requestId: 'req-dlq-1',
        orgId: 'org-001',
        limit: 10,
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-dlq.list.response');
      expect(response.requestId).toBe('req-dlq-1');
      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toEqual({
        id: 'evt-1',
        eventName: 'custom.thing',
        payload: { foo: 'bar' },
        sourceRepo: 'octo/repo',
        sourceRoutingKey: 'github:42',
        sourceRunId: null,
        sourceJobId: null,
        chainDepth: 0,
        createdAt: '2026-04-17T10:00:00.000Z',
        dlqAt: '2026-04-17T11:00:00.000Z',
        dlqReason: 'exhausted_retries',
        attempts: 5,
        lastError: 'boom',
      });
      expect(response.nextCursor).toBeNull();
    });

    it('emits nextCursor when the page is full', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      // Two rows back when limit is 2 — the cursor should be the second row's dlqAt.
      const eventStore = {
        listDlq: vi
          .fn()
          .mockResolvedValue([
            makeStoredEvent({ id: 'evt-1', dlqAt: new Date('2026-04-17T11:00:00Z') }),
            makeStoredEvent({ id: 'evt-2', dlqAt: new Date('2026-04-17T10:00:00Z') }),
          ]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        ...noopCallbacks,
      });

      await handler.handleEventDlqList({
        type: 'dashboard.event-dlq.list',
        requestId: 'req-dlq-2',
        orgId: 'org-001',
        limit: 2,
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.items).toHaveLength(2);
      expect(response.nextCursor).toBe('2026-04-17T10:00:00.000Z');
    });

    it('returns an empty list when eventStore is missing', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      await handler.handleEventDlqList({
        type: 'dashboard.event-dlq.list',
        requestId: 'req-dlq-3',
        orgId: 'org-001',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.items).toEqual([]);
      expect(response.error).toMatch(/not available/i);
    });
  });

  describe('handleEventDlqCount', () => {
    it('returns the DLQ depth', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const eventStore = {
        countDlq: vi.fn().mockResolvedValue(7),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        ...noopCallbacks,
      });

      await handler.handleEventDlqCount({
        type: 'dashboard.event-dlq.count',
        requestId: 'req-dlq-count-1',
        orgId: 'org-001',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-dlq.count.response');
      expect(response.total).toBe(7);
    });

    it('returns 0 when eventStore is missing', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const handler = new DashboardHandler({ db, logStorage, send, ...noopCallbacks });

      await handler.handleEventDlqCount({
        type: 'dashboard.event-dlq.count',
        requestId: 'req-dlq-count-2',
        orgId: 'org-001',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.total).toBe(0);
    });
  });

  describe('handleEventDlqRetry', () => {
    it('returns 404 when the row is not in DLQ', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const eventStore = {
        getById: vi.fn().mockResolvedValue(null),
        resetFromDlq: vi.fn(),
        getDb: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        ...noopCallbacks,
      });

      await handler.handleEventDlqRetry({
        type: 'dashboard.event-dlq.retry',
        requestId: 'req-dlq-retry-1',
        orgId: 'org-001',
        eventId: 'evt-missing',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-dlq.retry.response');
      expect(response.error).toMatch(/not found/i);
      expect(eventStore.resetFromDlq).not.toHaveBeenCalled();
    });

    it('writes an access_log row and resets the DLQ on success', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const fakeDb = {
        // sql tag's `.execute()` is invoked on the result of getDb()
      };
      const eventStore = {
        getById: vi.fn().mockResolvedValue({
          id: 'evt-1',
          dlqAt: new Date('2026-04-17T11:00:00Z'),
        }),
        resetFromDlq: vi.fn().mockResolvedValue(true),
        // sql`...`.execute(getDb()) is called on the result — our mock returns
        // something with no .execute() but the code wraps the call in try/catch
        // and logs a warn on failure. So the test passes either way.
        getDb: vi.fn().mockReturnValue(fakeDb),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        accessLog,
        ...noopCallbacks,
      });

      await handler.handleEventDlqRetry({
        type: 'dashboard.event-dlq.retry',
        requestId: 'req-dlq-retry-2',
        orgId: 'org-001',
        eventId: 'evt-1',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.retried).toBe(true);
      expect(eventStore.resetFromDlq).toHaveBeenCalledWith('evt-1');
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'event_dlq.retry',
        outcome: 'allowed',
        target: { type: 'event_dlq', id: 'evt-1' },
      });
    });
  });

  describe('handleEventDlqDiscard', () => {
    it('returns 404 when the row is not in DLQ', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const eventStore = {
        getById: vi.fn().mockResolvedValue(null),
        deleteDlq: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        ...noopCallbacks,
      });

      await handler.handleEventDlqDiscard({
        type: 'dashboard.event-dlq.discard',
        requestId: 'req-dlq-discard-1',
        orgId: 'org-001',
        eventId: 'evt-missing',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.type).toBe('dashboard.event-dlq.discard.response');
      expect(response.error).toMatch(/not found/i);
      expect(eventStore.deleteDlq).not.toHaveBeenCalled();
    });

    it('writes an access_log row and deletes the row on success', async () => {
      const { db } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const eventStore = {
        getById: vi.fn().mockResolvedValue({
          id: 'evt-1',
          dlqAt: new Date('2026-04-17T11:00:00Z'),
        }),
        deleteDlq: vi.fn().mockResolvedValue(true),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        eventStore,
        accessLog,
        ...noopCallbacks,
      });

      await handler.handleEventDlqDiscard({
        type: 'dashboard.event-dlq.discard',
        requestId: 'req-dlq-discard-2',
        orgId: 'org-001',
        eventId: 'evt-1',
        actor: { type: 'user', sub: 'alice' },
      });

      const response = send.mock.calls[0][0];
      expect(response.discarded).toBe(true);
      expect(eventStore.deleteDlq).toHaveBeenCalledWith('evt-1');
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'event_dlq.discard',
        outcome: 'allowed',
        target: { type: 'event_dlq', id: 'evt-1' },
      });
    });
  });

  describe('handleSourcesList', () => {
    it('handleSourcesList returns source summaries from both tables and records a platform_operator access_log row', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectWhere },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();
      const accessLogRecord = vi.fn();
      const accessLog = {
        record: accessLogRecord,
        query: vi.fn(),
        getById: vi.fn(),
        setColdStore: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: 'org-1',
        routingKey: 'github:42',
        accessLog,
        ...noopCallbacks,
      });

      // mock the two scoped queries IN ORDER: sources, then generic_webhook_sources.
      execute.mockResolvedValueOnce([
        {
          routing_key: 'github:42',
          name: 'acme/repo',
          provider: 'github',
          created_at: new Date('2026-05-30T10:00:00Z'),
        },
      ]);
      execute.mockResolvedValueOnce([
        {
          routing_key: 'generic:o:1',
          name: 'wh',
          provider_type: 'generic',
          git_config: null,
          enabled: false,
          created_at: new Date('2026-05-30T09:00:00Z'),
        },
      ]);

      const res = await handler.handleSourcesList({
        type: 'dashboard.sources.list',
        requestId: 'req-1',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 50,
      } as never);

      expect(res.type).toBe('dashboard.sources.list.response');
      expect(res.error).toBeUndefined();
      const gh = res.sources.find((s) => s.routingKey === 'github:42');
      expect(gh).toMatchObject({
        subtype: 'github_app',
        provider: 'github',
        enabled: true,
        name: 'acme/repo',
        createdAt: '2026-05-30T10:00:00.000Z',
      });
      const gen = res.sources.find((s) => s.routingKey === 'generic:o:1');
      expect(gen).toMatchObject({
        subtype: 'generic_webhook',
        provider: 'generic',
        enabled: false,
        name: 'wh',
      });
      // Newest-first ordering: github (10:00) before generic (09:00).
      expect(res.sources.map((s) => s.routingKey)).toEqual(['github:42', 'generic:o:1']);

      // Shape guard: the orchestrator must never leak secret/config columns
      // (config / git_config / verification_config) into a source summary.
      // git_config is read solely to derive `subtype`, never projected.
      const s = res.sources[0];
      expect(s).not.toHaveProperty('config');
      expect(s).not.toHaveProperty('git_config');
      expect(s).not.toHaveProperty('verification_config');
      expect(Object.keys(s).sort()).toEqual([
        'createdAt',
        'enabled',
        'name',
        'provider',
        'routingKey',
        'subtype',
      ]);

      // Both queries scoped to the bound org.
      expect(selectWhere).toHaveBeenCalledWith('customer_id', '=', 'org-1');

      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        orgId: 'org-1',
        routingKey: 'github:42',
        action: 'sources.list.read',
        source: 'platform_proxy',
        outcome: 'allowed',
        target: null,
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      });
    });

    it('handleSourcesList returns {sources:[]} when orgId is unbound', async () => {
      const {
        db,
        mocks: { selectExecute: execute, selectFrom },
      } = createMockDb();
      const logStorage = createMockLogStorage();
      const send = vi.fn();

      const handler = new DashboardHandler({
        db,
        logStorage,
        send,
        orgId: null,
        routingKey: null,
        ...noopCallbacks,
      });

      const res = await handler.handleSourcesList({
        type: 'dashboard.sources.list',
        requestId: 'req-unbound',
        actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
        limit: 50,
      } as never);

      expect(res.type).toBe('dashboard.sources.list.response');
      expect(res.sources).toEqual([]);
      expect(res.error).toBeUndefined();
      // No source query was issued.
      expect(selectFrom).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });
});

describe('groupNeedsByJobName', () => {
  it('groups edges by downstream job_name and parses run_on', () => {
    const grouped = groupNeedsByJobName([
      { job_name: 'test', upstream_name: 'build', run_on: JSON.stringify(['success']) },
      {
        job_name: 'deploy',
        upstream_name: 'test',
        run_on: JSON.stringify(['failed', 'timed_out_stale']),
      },
      { job_name: 'deploy', upstream_name: 'lint', run_on: JSON.stringify(['success']) },
    ]);
    expect(grouped.get('test')).toEqual([{ upstreamName: 'build', runOn: ['success'] }]);
    expect(grouped.get('deploy')).toEqual([
      { upstreamName: 'test', runOn: ['failed', 'timed_out_stale'] },
      { upstreamName: 'lint', runOn: ['success'] },
    ]);
  });

  it('defaults a malformed run_on to success-only', () => {
    const grouped = groupNeedsByJobName([
      { job_name: 'a', upstream_name: 'b', run_on: 'not-json' },
    ]);
    expect(grouped.get('a')).toEqual([{ upstreamName: 'b', runOn: ['success'] }]);
  });

  it('returns an empty map for no rows', () => {
    expect(groupNeedsByJobName([]).size).toBe(0);
  });
});
