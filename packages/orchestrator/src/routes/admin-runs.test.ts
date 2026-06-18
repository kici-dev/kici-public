/**
 * Tests for admin run inspection routes.
 *
 * Verifies auth, RBAC, query parameter filtering, and response shapes
 * for:
 *   GET /api/v1/admin/runs                        — list + filters
 *   GET /api/v1/admin/runs/:runId                 — run header only
 *   GET /api/v1/admin/runs/:runId/jobs            — jobs (+ optional steps)
 *   GET /api/v1/admin/runs/:runId/ephemeral-key   — scrub status
 *   GET /api/v1/admin/runs/:runId/secret-outputs  — masked / reveal + audit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRunRoutes, type AdminRunRoutesDeps } from './admin-runs.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import type { Role } from '../secrets/rbac.js';
import { encrypt, deriveKey } from '../secrets/crypto.js';

/**
 * Minimal mock for a Kysely query chain. Each call in the builder chain
 * returns the same proxy, and terminal executors are swappable via the
 * returned vi.fn() references so tests can stage per-call responses.
 */
function createMockDb() {
  const mockExecute = vi.fn().mockResolvedValue([]);
  const mockExecuteTakeFirst = vi.fn().mockResolvedValue(undefined);
  const mockExecuteTakeFirstOrThrow = vi.fn().mockResolvedValue({ total: 0 });

  const chainMethods: Record<string, any> = {};
  const chain = new Proxy(chainMethods, {
    get(_target, prop) {
      if (prop === 'execute') return mockExecute;
      if (prop === 'executeTakeFirst') return mockExecuteTakeFirst;
      if (prop === 'executeTakeFirstOrThrow') return mockExecuteTakeFirstOrThrow;
      return () => chain;
    },
  });

  return {
    selectFrom: () => chain,
    fn: { countAll: () => ({ as: () => 'count' }) },
    mockExecute,
    mockExecuteTakeFirst,
    mockExecuteTakeFirstOrThrow,
  };
}

/** Master secret key used only for test reveal round-trips. */
const TEST_SECRET_KEY = 'a'.repeat(64);

interface Deps extends AdminRunRoutesDeps {
  mockDb: ReturnType<typeof createMockDb>;
  auditLoggerLog: ReturnType<typeof vi.fn>;
}

function createMockDeps(overrides: Partial<AdminRunRoutesDeps> = {}): Deps {
  const mockDb = createMockDb();
  const auditLoggerLog = vi.fn().mockResolvedValue(undefined);
  return {
    db: mockDb as any,
    tokenManager: { validate: vi.fn() } as any,
    rbac: new RbacEnforcer(),
    auditLogger: { log: auditLoggerLog } as any,
    masterSecretKey: TEST_SECRET_KEY,
    ...overrides,
    mockDb,
    auditLoggerLog,
  };
}

async function request(
  app: ReturnType<typeof createAdminRunRoutes>,
  path: string,
  opts?: { token?: string },
) {
  const headers: Record<string, string> = {};
  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
  const url = `http://localhost/api/v1/admin/runs${path}`;
  return app.request(url, { method: 'GET', headers });
}

describe('admin run routes', () => {
  let deps: Deps;
  let app: ReturnType<typeof createAdminRunRoutes>;
  const validToken = 'test-token-abc123';

  beforeEach(() => {
    deps = createMockDeps();
    app = createAdminRunRoutes(deps);
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'user-1',
      role: 'owner' as Role,
      routingKey: null,
      label: 'test',
    });
  });

  // ── auth + RBAC ─────────────────────────────────────────────────

  describe('auth', () => {
    it('rejects missing Authorization header with 401', async () => {
      const res = await request(app, '');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Missing authorization');
    });

    it('rejects invalid token with 401', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue(null);
      const res = await request(app, '', { token: 'bad-token' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired token');
    });
  });

  describe('RBAC', () => {
    it('allows auditor role (has run.read permission)', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });
      const res = await request(app, '', { token: validToken });
      expect(res.status).toBe(200);
    });
  });

  // ── GET /admin/runs ─────────────────────────────────────────────

  describe('GET /api/v1/admin/runs', () => {
    it('returns empty runs list with total 0', async () => {
      const res = await request(app, '', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    });

    it('returns runs with correct shape', async () => {
      const now = new Date();
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          run_id: 'run-1',
          workflow_name: 'ci',
          status: 'success',
          provider: 'github',
          repo_identifier: 'owner/repo',
          ref: 'refs/heads/master',
          sha: 'abc1234',
          started_at: now,
          completed_at: now,
          duration_ms: 5000,
          parent_run_id: null,
          triggered_by: null,
          failure_reason: null,
          environment: null,
          trust_tier: null,
          created_at: now,
        },
      ]);
      deps.mockDb.mockExecuteTakeFirstOrThrow.mockResolvedValueOnce({ total: 1 });

      const res = await request(app, '', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].runId).toBe('run-1');
      expect(body.runs[0].workflowName).toBe('ci');
      expect(body.total).toBe(1);
    });

    it('rejects invalid ?since with 400', async () => {
      const res = await request(app, '?since=not-a-date', { token: validToken });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid "since"');
    });

    it('rejects unknown ?status value with 400', async () => {
      const res = await request(app, '?status=success,bogus', { token: validToken });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid status');
    });

    it('honours ?count=true with count-only response shape', async () => {
      deps.mockDb.mockExecuteTakeFirstOrThrow.mockResolvedValueOnce({ total: 7 });
      const res = await request(
        app,
        '?count=true&since=2026-04-18T00:00:00Z&status=success,failed',
        {
          token: validToken,
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        total: 7,
        since: '2026-04-18T00:00:00.000Z',
        status: ['success', 'failed'],
        workflowName: null,
        repo: null,
      });
      // The count path must NOT query the list of rows.
      expect(deps.mockDb.mockExecute).not.toHaveBeenCalled();
    });
  });

  // ── GET /admin/runs/:runId (run header only) ────────────────────

  describe('GET /api/v1/admin/runs/:runId', () => {
    it('returns 404 for non-existent run', async () => {
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce(undefined);
      const res = await request(app, '/run-nonexistent', { token: validToken });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found');
    });

    it('returns run fields only (no jobs, no steps)', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({
        run_id: 'run-1',
        workflow_name: 'ci',
        status: 'success',
        provider: 'github',
        repo_identifier: 'owner/repo',
        ref: 'refs/heads/master',
        sha: 'abc1234',
        delivery_id: 'del-1',
        started_at: now,
        completed_at: now,
        duration_ms: 5000,
        is_test_run: false,
        parent_run_id: null,
        original_run_id: null,
        triggered_by: null,
        cancelled_by: null,
        environment: null,
        trust_tier: null,
        lock_file_source: null,
        contributor_username: null,
        failure_reason: null,
        created_at: now,
      });
      const res = await request(app, '/run-1', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run.runId).toBe('run-1');
      // The split endpoint must NOT return jobs or steps.
      expect(body.jobs).toBeUndefined();
      expect(body.steps).toBeUndefined();
    });
  });

  // ── GET /admin/runs/:runId/jobs ────────────────────────────────

  describe('GET /api/v1/admin/runs/:runId/jobs', () => {
    it('returns 404 when the run does not exist', async () => {
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce(undefined); // run existence check
      const res = await request(app, '/run-x/jobs', { token: validToken });
      expect(res.status).toBe(404);
    });

    it('returns jobs for a run without steps by default', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: 'run-1' });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          job_id: 'job-test',
          job_name: 'test',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: now,
          completed_at: now,
          duration_ms: 4000,
          error_message: null,
          runs_on_labels: '["kici:os:linux"]',
          created_at: now,
        },
      ]);
      // execution_job_needs query (no edges for this run).
      deps.mockDb.mockExecute.mockResolvedValueOnce([]);
      const res = await request(app, '/run-1/jobs', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].jobId).toBe('job-test');
      expect(body.jobs[0].runsOnLabels).toEqual(['kici:os:linux']);
      expect(body.jobs[0].needs).toBeNull();
      expect(body.jobs[0].steps).toBeUndefined();
    });

    it('attaches resolved dependency edges (needs) grouped by downstream job', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: 'run-1' });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          job_id: 'job-build',
          job_name: 'build',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: now,
          completed_at: now,
          duration_ms: 4000,
          error_message: null,
          runs_on_labels: null,
          created_at: now,
        },
        {
          job_id: 'job-deploy',
          job_name: 'deploy',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: now,
          completed_at: now,
          duration_ms: 4000,
          error_message: null,
          runs_on_labels: null,
          created_at: now,
        },
      ]);
      // execution_job_needs query: deploy depends on build (run-anyway policy).
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        { job_name: 'deploy', upstream_name: 'build', if_failed: 'run' },
      ]);
      const res = await request(app, '/run-1/jobs', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      const build = body.jobs.find((j: { jobName: string }) => j.jobName === 'build');
      const deploy = body.jobs.find((j: { jobName: string }) => j.jobName === 'deploy');
      expect(build.needs).toBeNull();
      expect(deploy.needs).toEqual([{ upstreamName: 'build', ifFailed: 'run' }]);
    });

    it('embeds steps when ?includeSteps=true', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: 'run-1' });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          job_id: 'job-test',
          job_name: 'test',
          status: 'success',
          matrix_values: null,
          agent_id: 'agent-1',
          started_at: now,
          completed_at: now,
          duration_ms: 4000,
          error_message: null,
          runs_on_labels: null,
          created_at: now,
        },
      ]);
      // execution_job_needs query (no edges) runs between the jobs and steps queries.
      deps.mockDb.mockExecute.mockResolvedValueOnce([]);
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          job_id: 'job-test',
          step_index: 0,
          step_name: 'checkout',
          status: 'success',
          started_at: now,
          completed_at: now,
          duration_ms: 1000,
          exit_code: 0,
          error_message: null,
          step_type: 'step',
        },
      ]);
      const res = await request(app, '/run-1/jobs?includeSteps=true', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs[0].steps).toHaveLength(1);
      expect(body.jobs[0].steps[0].stepName).toBe('checkout');
    });
  });

  // ── GET /admin/runs/:runId/ephemeral-key ───────────────────────

  describe('GET /api/v1/admin/runs/:runId/ephemeral-key', () => {
    it('returns 404 when the run does not exist', async () => {
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce(undefined);
      const res = await request(app, '/run-x/ephemeral-key', { token: validToken });
      expect(res.status).toBe(404);
    });

    it('returns {exists: true, createdAt} when the row is present', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst
        .mockResolvedValueOnce({ run_id: 'run-1' })
        .mockResolvedValueOnce({ run_id: 'run-1', created_at: now });
      const res = await request(app, '/run-1/ephemeral-key', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ exists: true, createdAt: now.toISOString() });
    });

    it('returns {exists: false, createdAt: null} when the row has been scrubbed', async () => {
      deps.mockDb.mockExecuteTakeFirst
        .mockResolvedValueOnce({ run_id: 'run-1' })
        .mockResolvedValueOnce(undefined);
      const res = await request(app, '/run-1/ephemeral-key', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ exists: false, createdAt: null });
    });

    it('never leaks the public_key or encrypted_private_key', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst
        .mockResolvedValueOnce({ run_id: 'run-1' })
        .mockResolvedValueOnce({
          run_id: 'run-1',
          created_at: now,
          public_key: 'must-not-appear',
          encrypted_private_key: 'must-not-appear',
        });
      const res = await request(app, '/run-1/ephemeral-key', { token: validToken });
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('must-not-appear');
    });
  });

  // ── GET /admin/runs/:runId/secret-outputs ──────────────────────

  describe('GET /api/v1/admin/runs/:runId/secret-outputs', () => {
    it('returns 404 when the run does not exist', async () => {
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce(undefined);
      const res = await request(app, '/run-x/secret-outputs', { token: validToken });
      expect(res.status).toBe(404);
    });

    it('returns masked rows by default (no value field)', async () => {
      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: 'run-1' });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          id: 'out-1',
          job_id: 'job-a',
          output_key: 'API_KEY',
          encrypted_value: 'base64-ciphertext',
          created_at: now,
        },
      ]);
      const res = await request(app, '/run-1/secret-outputs', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.outputs).toHaveLength(1);
      expect(body.outputs[0].value).toBeNull();
      expect(body.outputs[0].masked).toBe(true);
      // Ciphertext must NOT appear in the masked response.
      expect(JSON.stringify(body)).not.toContain('base64-ciphertext');
      // No audit row for a non-reveal read.
      expect(deps.auditLoggerLog).not.toHaveBeenCalled();
    });

    it('rejects ?reveal=true with 403 when role lacks secret.reveal', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });
      const res = await request(app, '/run-1/secret-outputs?reveal=true', { token: validToken });
      expect(res.status).toBe(403);
    });

    it('503s on ?reveal=true when masterSecretKey or auditLogger is missing', async () => {
      const depsNoKey = createMockDeps({ masterSecretKey: undefined, auditLogger: undefined });
      (depsNoKey.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appNoKey = createAdminRunRoutes(depsNoKey);
      const res = await request(appNoKey, '/run-1/secret-outputs?reveal=true', {
        token: validToken,
      });
      expect(res.status).toBe(503);
    });

    it('decrypts values on ?reveal=true and writes a single audit row', async () => {
      const runId = 'run-1';
      const plaintext = 'super-secret';
      const keyBuf = deriveKey(TEST_SECRET_KEY);
      const { data: ciphertext } = encrypt(plaintext, keyBuf, 1, `secret-output:${runId}`);

      const now = new Date();
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: runId });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          id: 'out-1',
          job_id: 'job-a',
          output_key: 'API_KEY',
          encrypted_value: ciphertext,
          created_at: now,
        },
      ]);

      const res = await request(app, `/${runId}/secret-outputs?reveal=true`, { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.outputs).toHaveLength(1);
      expect(body.outputs[0].value).toBe(plaintext);
      expect(body.outputs[0].masked).toBe(false);

      expect(deps.auditLoggerLog).toHaveBeenCalledTimes(1);
      const entry = deps.auditLoggerLog.mock.calls[0][0];
      expect(entry.action).toBe('secret-outputs.reveal');
      expect(entry.runId).toBe(runId);
      expect(entry.secretKeys).toEqual(['API_KEY']);
      expect(entry.outcome).toBe('allowed');
      expect(entry.userId).toBe('user-1');
    });

    it('records a revealError row when the ciphertext cannot be decrypted', async () => {
      deps.mockDb.mockExecuteTakeFirst.mockResolvedValueOnce({ run_id: 'run-1' });
      deps.mockDb.mockExecute.mockResolvedValueOnce([
        {
          id: 'out-1',
          job_id: 'job-a',
          output_key: 'API_KEY',
          encrypted_value: 'not-valid-ciphertext',
          created_at: new Date(),
        },
      ]);
      const res = await request(app, '/run-1/secret-outputs?reveal=true', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.outputs[0].masked).toBe(true);
      expect(body.outputs[0].value).toBeNull();
      expect(body.outputs[0].revealError).toBeTruthy();

      // The audit row should still fire, with failedCount: 1.
      expect(deps.auditLoggerLog).toHaveBeenCalledTimes(1);
      const entry = deps.auditLoggerLog.mock.calls[0][0];
      expect(entry.metadata.failedCount).toBe(1);
      expect(entry.metadata.revealedCount).toBe(0);
    });
  });
});
