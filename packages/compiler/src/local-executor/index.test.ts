import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workflow, Job } from '@kici-dev/sdk';
import type { SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import type { ResolvedJob } from './types.js';

// Mock all subsystem modules
const mockCompileCommand = vi.fn().mockResolvedValue(true);
vi.mock('../commands/compile.js', () => ({
  compileCommand: (...args: unknown[]) => mockCompileCommand(...args),
}));

const mockDiscoverWorkflows = vi.fn().mockResolvedValue({
  workflows: [],
  workflowDir: '/tmp/.kici/workflows',
});
const mockResolveKiciDir = vi.fn().mockReturnValue('/tmp/.kici');
vi.mock('../execution/index.js', () => ({
  discoverWorkflows: (...args: unknown[]) => mockDiscoverWorkflows(...args),
  resolveKiciDir: (...args: unknown[]) => mockResolveKiciDir(...args),
}));

const mockLoadLocalSecrets = vi.fn().mockResolvedValue({ flat: {}, contexts: {} });
vi.mock('./secret-loader.js', () => ({
  loadLocalSecrets: (...args: unknown[]) => mockLoadLocalSecrets(...args),
}));

const mockGenerateEventPayload = vi.fn().mockResolvedValue({
  type: 'push',
  payload: { ref: 'refs/heads/main' },
  targetBranch: 'main',
  changedFiles: [],
} as SimulatedEvent);
vi.mock('./payload-generator.js', () => ({
  generateEventPayload: (...args: unknown[]) => mockGenerateEventPayload(...args),
}));

const mockMatchAllWorkflows = vi.fn().mockReturnValue([]);
vi.mock('@kici-dev/engine', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    matchAllWorkflows: (...args: unknown[]) => mockMatchAllWorkflows(...args),
  };
});

const mockResolveJobs = vi.fn().mockResolvedValue([]);
vi.mock('./job-runner.js', () => ({
  resolveJobs: (...args: unknown[]) => mockResolveJobs(...args),
  executeResolvedJob: vi.fn(),
}));

const mockExecuteDag = vi.fn().mockResolvedValue({
  results: new Map(),
  skipped: [],
  cancelled: [],
  status: 'success',
});
const mockResolveJobFilter = vi.fn();
vi.mock('./dag-scheduler.js', () => ({
  executeDag: (...args: unknown[]) => mockExecuteDag(...args),
  resolveJobFilter: (...args: unknown[]) => mockResolveJobFilter(...args),
}));

// Mock output-formatter
vi.mock('../test-runner/output-formatter.js', () => ({
  formatter: {
    logJobStart: vi.fn(),
    logJobComplete: vi.fn(),
    logJobFailure: vi.fn(),
    logJobLine: vi.fn(),
    logStepStart: vi.fn(),
    logStepComplete: vi.fn(),
    logStepError: vi.fn(),
    logRuleResult: vi.fn(),
  },
}));

// Mock lockfile loading
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  };
});

vi.mock('../lockfile/generator.js', () => ({
  transformTriggers: vi.fn().mockReturnValue([]),
}));

const mockCleanup = vi.fn().mockResolvedValue(undefined);
const mockMaterializeCheckout = vi
  .fn()
  .mockResolvedValue({ path: '/tmp/kici-run-test', cleanup: mockCleanup });
vi.mock('./materializer.js', () => ({
  materializeCheckout: (...args: unknown[]) => mockMaterializeCheckout(...args),
  gcStaleRunCheckouts: async () => [],
}));

import { executeLocal } from './index.js';

function makeJob(name: string): Job {
  return {
    _tag: 'Job' as const,
    name,
    runsOn: 'local',
    steps: [],
    result: {} as any,
  } as Job;
}

function makeWorkflow(name: string, jobs: Job[] = []): Workflow {
  return {
    _tag: 'Workflow' as const,
    name,
    on: {},
    jobs,
  } as unknown as Workflow;
}

function makeDecision(name: string, matched: boolean): WorkflowDecision {
  return {
    workflowName: name,
    matched,
    checks: [],
  } as WorkflowDecision;
}

function makeResolvedJob(name: string): ResolvedJob {
  return {
    job: makeJob(name),
    expandedName: name,
    matrixValues: {},
    resolvedNeeds: [],
  };
}

describe('executeLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockCompileCommand.mockResolvedValue(true);
    mockDiscoverWorkflows.mockResolvedValue({
      workflows: [{ workflow: makeWorkflow('ci', [makeJob('lint')]) }],
      workflowDir: '/tmp/.kici/workflows',
    });
    mockLoadLocalSecrets.mockResolvedValue({ flat: {}, contexts: {} });
    mockGenerateEventPayload.mockResolvedValue({
      type: 'push',
      payload: { ref: 'refs/heads/main' },
      targetBranch: 'main',
      changedFiles: [],
    });
    mockMatchAllWorkflows.mockReturnValue([makeDecision('ci', true)]);
    mockResolveJobs.mockResolvedValue([makeResolvedJob('lint')]);
    mockExecuteDag.mockResolvedValue({
      results: new Map(),
      skipped: [],
      cancelled: [],
      status: 'success',
    });
    mockMaterializeCheckout.mockResolvedValue({ path: '/tmp/kici-run-test', cleanup: mockCleanup });
  });

  it('calls compile, load, match, resolve, execute pipeline in order', async () => {
    const result = await executeLocal({ event: 'push', inPlace: true });

    expect(mockCompileCommand).toHaveBeenCalled();
    expect(mockDiscoverWorkflows).toHaveBeenCalled();
    expect(mockLoadLocalSecrets).toHaveBeenCalled();
    expect(mockGenerateEventPayload).toHaveBeenCalled();
    expect(mockMatchAllWorkflows).toHaveBeenCalled();
    expect(mockResolveJobs).toHaveBeenCalled();
    expect(mockExecuteDag).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('returns true when all workflows succeed', async () => {
    mockExecuteDag.mockResolvedValue({
      results: new Map(),
      skipped: [],
      cancelled: [],
      status: 'success',
    });

    const result = await executeLocal({ event: 'push', inPlace: true });
    expect(result).toBe(true);
  });

  it('returns false when any workflow fails', async () => {
    mockExecuteDag.mockResolvedValue({
      results: new Map(),
      skipped: [],
      cancelled: [],
      status: 'failure',
    });

    const result = await executeLocal({ event: 'push', inPlace: true });
    expect(result).toBe(false);
  });

  it('applies --workflow filter to matched workflows', async () => {
    mockDiscoverWorkflows.mockResolvedValue({
      workflows: [
        { workflow: makeWorkflow('ci', [makeJob('lint')]) },
        { workflow: makeWorkflow('deploy', [makeJob('push')]) },
      ],
      workflowDir: '/tmp/.kici/workflows',
    });
    mockMatchAllWorkflows.mockReturnValue([makeDecision('ci', true), makeDecision('deploy', true)]);

    await executeLocal({ event: 'push', workflow: 'ci', inPlace: true });

    // Only 'ci' workflow should be resolved and executed
    expect(mockResolveJobs).toHaveBeenCalledTimes(1);
    const resolveCallWorkflow = mockResolveJobs.mock.calls[0][0] as Workflow;
    expect(resolveCallWorkflow.name).toBe('ci');
  });

  it('applies --job filter via resolveJobFilter to restrict DAG scope', async () => {
    const resolvedJobs = [makeResolvedJob('setup'), makeResolvedJob('lint')];
    mockResolveJobs.mockResolvedValue(resolvedJobs);
    mockResolveJobFilter.mockReturnValue([
      { name: 'setup', needs: [] },
      { name: 'lint', needs: ['setup'] },
    ]);

    await executeLocal({ event: 'push', job: 'lint', inPlace: true });

    expect(mockResolveJobFilter).toHaveBeenCalled();
  });

  it('passes keepGoing option through to DAG failFast (inverted)', async () => {
    await executeLocal({ event: 'push', keepGoing: true, inPlace: true });

    const dagCallOptions = mockExecuteDag.mock.calls[0][2];
    expect(dagCallOptions.failFast).toBe(false);
  });

  it('handles compilation errors gracefully', async () => {
    mockCompileCommand.mockResolvedValue(false);

    const result = await executeLocal({ event: 'push' });

    expect(result).toBe(false);
    // Should not proceed to match/execute
    expect(mockMatchAllWorkflows).not.toHaveBeenCalled();
  });

  it('skips execution when no workflows match and returns true', async () => {
    mockMatchAllWorkflows.mockReturnValue([makeDecision('ci', false)]);

    const result = await executeLocal({ event: 'push' });

    expect(result).toBe(true);
    expect(mockExecuteDag).not.toHaveBeenCalled();
  });

  it('treats rule-skipped jobs as successful (not failures) via isSuccess callback', async () => {
    mockResolveJobs.mockResolvedValue([makeResolvedJob('lint')]);

    // The DAG mock captures the isSuccess callback
    mockExecuteDag.mockImplementation(async (_nodes: unknown, callbacks: any) => {
      // Verify that isSuccess treats 'skipped' as success
      expect(callbacks.isSuccess({ status: 'skipped' })).toBe(true);
      expect(callbacks.isSuccess({ status: 'success' })).toBe(true);
      expect(callbacks.isSuccess({ status: 'failure' })).toBe(false);

      return { results: new Map(), skipped: [], cancelled: [], status: 'success' };
    });

    await executeLocal({ event: 'push', inPlace: true });
    expect(mockExecuteDag).toHaveBeenCalled();
  });

  describe('execution isolation', () => {
    it('materializes an isolated checkout by default and cleans it up on success', async () => {
      mockExecuteDag.mockResolvedValue({
        results: new Map(),
        skipped: [],
        cancelled: [],
        status: 'success',
      });

      const result = await executeLocal({ event: 'push' });

      expect(result).toBe(true);
      expect(mockMaterializeCheckout).toHaveBeenCalledTimes(1);
      // execDir flows into the DAG executor's job context, not directly visible
      // here, but cleanup proves the isolated dir was created and removed.
      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it('keeps the isolated checkout on failure', async () => {
      mockExecuteDag.mockResolvedValue({
        results: new Map(),
        skipped: [],
        cancelled: [],
        status: 'failure',
      });

      const result = await executeLocal({ event: 'push' });

      expect(result).toBe(false);
      expect(mockMaterializeCheckout).toHaveBeenCalledTimes(1);
      expect(mockCleanup).not.toHaveBeenCalled();
    });

    it('retains the isolated checkout on success when --keep is set', async () => {
      const result = await executeLocal({ event: 'push', keep: true });

      expect(result).toBe(true);
      expect(mockMaterializeCheckout).toHaveBeenCalledTimes(1);
      expect(mockCleanup).not.toHaveBeenCalled();
    });

    it('does not materialize when --in-place is set', async () => {
      const result = await executeLocal({ event: 'push', inPlace: true });

      expect(result).toBe(true);
      expect(mockMaterializeCheckout).not.toHaveBeenCalled();
      expect(mockCleanup).not.toHaveBeenCalled();
    });
  });

  describe('workflow-level concurrency lock', () => {
    let tmpRuntimeDir: string;
    let originalXdg: string | undefined;

    beforeEach(async () => {
      tmpRuntimeDir = await mkdtemp(path.join(os.tmpdir(), 'kici-local-exec-test-'));
      originalXdg = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = tmpRuntimeDir;
    });

    afterEach(async () => {
      if (originalXdg === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = originalXdg;
      }
      await rm(tmpRuntimeDir, { recursive: true, force: true });
    });

    it('serializes two concurrent executeLocal() calls when concurrency is declared', async () => {
      // Build a workflow with a concurrency block keyed to a static group.
      const wf = {
        _tag: 'Workflow' as const,
        name: 'deploy',
        on: {},
        jobs: [makeJob('build')],
        concurrency: { group: () => 'static-group' },
      } as unknown as Workflow;

      mockDiscoverWorkflows.mockResolvedValue({
        workflows: [{ workflow: wf }],
        workflowDir: '/tmp/.kici/workflows',
      });
      mockMatchAllWorkflows.mockReturnValue([makeDecision('deploy', true)]);
      mockResolveJobs.mockResolvedValue([makeResolvedJob('build')]);

      // Each call's executeDag waits 200ms — long enough for the assertion to
      // distinguish "ran in parallel" (~200ms total) from "serialized" (~400ms).
      mockExecuteDag.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { results: new Map(), skipped: [], cancelled: [], status: 'success' };
      });

      const start = Date.now();
      const [r1, r2] = await Promise.all([
        executeLocal({ event: 'push', quiet: true, inPlace: true }),
        executeLocal({ event: 'push', quiet: true, inPlace: true }),
      ]);
      const elapsed = Date.now() - start;

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      // Both calls hit executeDag, but serialized.
      expect(mockExecuteDag).toHaveBeenCalledTimes(2);
      // Wall clock should be at least 2x the per-run baseline (>= 380ms with
      // a 20ms slack for scheduler jitter). If they had run in parallel,
      // total would be ~200ms.
      expect(elapsed).toBeGreaterThanOrEqual(380);
    }, 5_000);
  });
});
