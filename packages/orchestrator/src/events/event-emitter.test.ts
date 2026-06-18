/**
 * Tests for EventEmitter -- system event emission on workflow/job completion.
 *
 * Mocks EventRouter to verify:
 * - emitWorkflowComplete produces correct event name and payload
 * - emitJobComplete produces correct event name and payload
 * - chainDepth is always 0 for system events
 * - source fields are set correctly
 */
import { describe, it, expect, vi } from 'vitest';

import { EventEmitter, type WorkflowCompleteData, type JobCompleteData } from './event-emitter.js';
import type { EventRouter } from './event-router.js';

// ── Mock helpers ────────────────────────────────────────────────

function createMockRouter() {
  return {
    emit: vi.fn().mockResolvedValue('evt-sys-001'),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as EventRouter;
}

// ── Tests ────────────────────────────────────────────────────────

describe('EventEmitter', () => {
  describe('emitWorkflowComplete', () => {
    it('should emit __workflow_complete with correct event name and payload', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      const data: WorkflowCompleteData = {
        routingKey: 'github:42',
        repo: 'owner/repo',
        workflowName: 'CI',
        runId: 'run-123',
        status: 'success',
        conclusion: 'All jobs passed',
        duration: 30000,
        jobResults: [
          { name: 'build', status: 'success' },
          { name: 'test', status: 'success' },
        ],
      };

      const eventId = await emitter.emitWorkflowComplete(data);

      expect(eventId).toBe('evt-sys-001');
      expect(router.emit).toHaveBeenCalledWith({
        eventName: '__workflow_complete',
        payload: {
          workflowName: 'CI',
          runId: 'run-123',
          status: 'success',
          conclusion: 'All jobs passed',
          duration: 30000,
          jobResults: [
            { name: 'build', status: 'success' },
            { name: 'test', status: 'success' },
          ],
          sourceRepo: 'owner/repo',
          sourceRoutingKey: 'github:42',
        },
        sourceRepo: 'owner/repo',
        sourceRoutingKey: 'github:42',
        sourceRunId: 'run-123',
        chainDepth: 0,
      });
    });

    it('should always set chainDepth to 0 for workflow complete events', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      await emitter.emitWorkflowComplete({
        routingKey: 'github:42',
        repo: 'owner/repo',
        workflowName: 'Deploy',
        runId: 'run-456',
        status: 'failed',
        conclusion: 'Job "deploy" failed',
        duration: 5000,
        jobResults: [{ name: 'deploy', status: 'failed' }],
      });

      const emitCall = (router.emit as any).mock.calls[0][0];
      expect(emitCall.chainDepth).toBe(0);
    });

    it('should set source fields correctly', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      await emitter.emitWorkflowComplete({
        routingKey: 'github:99',
        repo: 'org/monorepo',
        workflowName: 'Release',
        runId: 'run-789',
        status: 'success',
        conclusion: 'Released v1.0.0',
        duration: 120000,
        jobResults: [],
      });

      const emitCall = (router.emit as any).mock.calls[0][0];
      expect(emitCall.sourceRepo).toBe('org/monorepo');
      expect(emitCall.sourceRoutingKey).toBe('github:99');
      expect(emitCall.sourceRunId).toBe('run-789');
    });
  });

  describe('emitJobComplete', () => {
    it('should emit __job_complete with correct event name and payload', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      const data: JobCompleteData = {
        routingKey: 'github:42',
        repo: 'owner/repo',
        workflowName: 'CI',
        jobName: 'build',
        runId: 'run-123',
        jobId: 'job-456',
        status: 'success',
        duration: 15000,
        stepResults: [
          { name: 'checkout', status: 'success' },
          { name: 'compile', status: 'success' },
          { name: 'test', status: 'success' },
        ],
      };

      const eventId = await emitter.emitJobComplete(data);

      expect(eventId).toBe('evt-sys-001');
      expect(router.emit).toHaveBeenCalledWith({
        eventName: '__job_complete',
        payload: {
          workflowName: 'CI',
          jobName: 'build',
          runId: 'run-123',
          jobId: 'job-456',
          status: 'success',
          duration: 15000,
          stepResults: [
            { name: 'checkout', status: 'success' },
            { name: 'compile', status: 'success' },
            { name: 'test', status: 'success' },
          ],
          sourceRepo: 'owner/repo',
          sourceRoutingKey: 'github:42',
        },
        sourceRepo: 'owner/repo',
        sourceRoutingKey: 'github:42',
        sourceRunId: 'run-123',
        sourceJobId: 'job-456',
        chainDepth: 0,
      });
    });

    it('should always set chainDepth to 0 for job complete events', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      await emitter.emitJobComplete({
        routingKey: 'github:42',
        repo: 'owner/repo',
        workflowName: 'CI',
        jobName: 'test',
        runId: 'run-123',
        jobId: 'job-789',
        status: 'failed',
        duration: 5000,
        stepResults: [{ name: 'run-tests', status: 'failed' }],
      });

      const emitCall = (router.emit as any).mock.calls[0][0];
      expect(emitCall.chainDepth).toBe(0);
    });

    it('should set source fields including jobId correctly', async () => {
      const router = createMockRouter();
      const emitter = new EventEmitter(router);

      await emitter.emitJobComplete({
        routingKey: 'github:99',
        repo: 'org/service',
        workflowName: 'Deploy',
        jobName: 'deploy-prod',
        runId: 'run-100',
        jobId: 'job-200',
        status: 'success',
        duration: 60000,
        stepResults: [],
      });

      const emitCall = (router.emit as any).mock.calls[0][0];
      expect(emitCall.sourceRepo).toBe('org/service');
      expect(emitCall.sourceRoutingKey).toBe('github:99');
      expect(emitCall.sourceRunId).toBe('run-100');
      expect(emitCall.sourceJobId).toBe('job-200');
    });
  });
});
