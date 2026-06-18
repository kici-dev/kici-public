import { describe, it, expect } from 'vitest';
import { executeJob, executeWorkflow } from './job-executor.js';
import { step, job, workflow, rule, getStepOutputsMap, getJobOutputsMap } from '@kici-dev/sdk';
import type { SimulatedEvent } from '@kici-dev/engine';

describe('job-executor', () => {
  const mockEvent: SimulatedEvent = {
    type: 'push',
    payload: {},
    targetBranch: 'main',
    changedFiles: [],
  };

  // Tests don't run shell commands that depend on cwd; passing the current
  // working directory keeps the historical behavior.
  const TEST_REPO_ROOT = process.cwd();

  describe('executeStep', () => {
    it('should execute step successfully', async () => {
      const testStep = step('test', async ({ log }) => {
        log.info('test message');
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [testStep],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('success');
      expect(result.steps[0].name).toBe('test');
    });

    it('should handle step failure', async () => {
      const failingStep = step('failing', async () => {
        throw new Error('Step failed');
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [failingStep],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('failure');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('failure');
      expect(result.steps[0].error?.message).toBe('Step failed');
      expect(result.error?.message).toBe('Step failed');
    });

    it('should fail fast on first step failure', async () => {
      const step1 = step('step-1', async () => {
        throw new Error('Step 1 failed');
      });
      const step2 = step('step-2', async () => {
        // This should not execute
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [step1, step2],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('failure');
      expect(result.steps).toHaveLength(1); // Only first step should execute
      expect(result.steps[0].name).toBe('step-1');
    });

    it('should capture step outputs', async () => {
      const step1 = step('step-1', {
        outputs: {},
        run: async () => {
          return {};
        },
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [step1],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps[0].outputs).toBeDefined();
    });
  });

  describe('executeJob with rules', () => {
    it('should skip job when rule fails', async () => {
      const failingRule = rule('test rule', () => false);

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [step('test', async () => {})],
        rules: [failingRule],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('skipped');
      expect(result.steps).toHaveLength(0);
      expect(result.ruleResults).toHaveLength(1);
      expect(result.ruleResults?.[0].passed).toBe(false);
    });

    it('should execute job when rule passes', async () => {
      const passingRule = rule('test rule', () => true);

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [step('test', async () => {})],
        rules: [passingRule],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps).toHaveLength(1);
      expect(result.ruleResults).toHaveLength(1);
      expect(result.ruleResults?.[0].passed).toBe(true);
    });

    it('should fail fast on rule evaluation', async () => {
      const rule1 = rule('rule-1', () => false);
      const rule2 = rule('rule-2', () => true);

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [step('test', async () => {})],
        rules: [rule1, rule2],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('skipped');
      expect(result.ruleResults).toHaveLength(1); // Should stop after first failure
      expect(result.ruleResults?.[0].label).toBe('rule-1');
    });
  });

  describe('executeWorkflow', () => {
    it('should execute single job workflow', async () => {
      const testWorkflow = workflow('test', {
        jobs: [
          job('job-1', {
            runsOn: 'kici:os:linux',
            steps: [step('step-1', async () => {})],
          }),
        ],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].status).toBe('success');
    });

    it('should execute parallel jobs', async () => {
      const testWorkflow = workflow('test', {
        jobs: [
          job('job-1', {
            runsOn: 'kici:os:linux',
            steps: [step('step-1', async () => {})],
          }),
          job('job-2', {
            runsOn: 'kici:os:linux',
            steps: [step('step-2', async () => {})],
          }),
        ],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs.every((j) => j.status === 'success')).toBe(true);
    });

    it('should respect job dependencies', async () => {
      const job1 = job('job-1', {
        runsOn: 'kici:os:linux',
        steps: [step('step-1', async () => {})],
      });

      const job2 = job('job-2', {
        runsOn: 'kici:os:linux',
        steps: [step('step-2', async () => {})],
        needs: [job1],
      });

      const testWorkflow = workflow('test', {
        jobs: [job1, job2],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(2);

      // Both jobs should complete
      const job1Result = result.jobs.find((j) => j.name === 'job-1');
      const job2Result = result.jobs.find((j) => j.name === 'job-2');
      expect(job1Result?.status).toBe('success');
      expect(job2Result?.status).toBe('success');
    });

    it('should fail fast when job fails', async () => {
      const job1 = job('job-1', {
        runsOn: 'kici:os:linux',
        steps: [
          step('failing', async () => {
            throw new Error('Job 1 failed');
          }),
        ],
      });

      const job2 = job('job-2', {
        runsOn: 'kici:os:linux',
        steps: [step('step-2', async () => {})],
        needs: [job1],
      });

      const testWorkflow = workflow('test', {
        jobs: [job1, job2],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('failure');
      expect(result.jobs).toHaveLength(1); // Only job1 should run
      expect(result.jobs[0].name).toBe('job-1');
      expect(result.jobs[0].status).toBe('failure');
    });

    it('should skip workflow when rule fails', async () => {
      const failingRule = rule('workflow rule', () => false);

      const testWorkflow = workflow('test', {
        jobs: [
          job('job-1', {
            runsOn: 'kici:os:linux',
            steps: [step('step-1', async () => {})],
          }),
        ],
        rules: [failingRule],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('skipped');
      expect(result.jobs).toHaveLength(0);
      expect(result.ruleResults).toHaveLength(1);
      expect(result.ruleResults?.[0].passed).toBe(false);
    });

    it('should handle needs as string reference', async () => {
      const job1 = job('job-1', {
        runsOn: 'kici:os:linux',
        steps: [step('step-1', async () => {})],
      });

      const job2 = job('job-2', {
        runsOn: 'kici:os:linux',
        steps: [step('step-2', async () => {})],
        needs: ['job-1'],
      });

      const testWorkflow = workflow('test', {
        jobs: [job1, job2],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('output capture and chaining', () => {
    it('should populate step outputs map for within-job chaining', async () => {
      const buildStep = step('build', async () => {
        return { version: '1.0.0', artifact: 'dist/main.js' };
      });

      const verifyStep = step('verify', async (ctx) => {
        const outputs = ctx.outputsOf<{ version: string; artifact: string }>(buildStep);
        return { verified: outputs.version === '1.0.0' };
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [buildStep, verifyStep],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].outputs).toEqual({ version: '1.0.0', artifact: 'dist/main.js' });
      expect(result.steps[1].outputs).toEqual({ verified: true });
    });

    it('should support .result proxy for within-job chaining', async () => {
      const buildStep = step('build', async () => {
        return { version: '2.0.0' };
      });

      const checkStep = step('check', async () => {
        // Access outputs via .result proxy (resolves against the shared outputs map)
        const ver = buildStep.result.version;
        return { checkedVersion: ver };
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [buildStep, checkStep],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps[1].outputs).toEqual({ checkedVersion: '2.0.0' });
    });

    it('should support bare function output capture and ctx.outputsOf', async () => {
      const bareFn = async () => {
        return { status: 'ready' };
      };

      const checkStep = step('check', async (ctx) => {
        const outputs = ctx.outputsOf<{ status: string }>(bareFn);
        return { resolved: outputs.status };
      });

      const testJob = job('test-job', {
        runsOn: 'kici:os:linux',
        steps: [bareFn, checkStep],
      });

      const result = await executeJob(testJob, 'test-workflow', mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.steps[0].name).toBe('step-1');
      expect(result.steps[0].outputs).toEqual({ status: 'ready' });
      expect(result.steps[1].outputs).toEqual({ resolved: 'ready' });
    });

    it('should collect cross-job outputs for multi-step jobs', async () => {
      const job1 = job('setup', {
        runsOn: 'kici:os:linux',
        steps: [
          step('init', async () => {
            return { env: 'production' };
          }),
          step('config', async () => {
            return { port: 8080 };
          }),
        ],
      });

      const job2 = job('deploy', {
        runsOn: 'kici:os:linux',
        needs: [job1],
        steps: [
          step('deploy', async (ctx) => {
            const setupOutputs = ctx.jobOutputs(job1);
            return { deployed: true, setupData: setupOutputs };
          }),
        ],
      });

      const testWorkflow = workflow('test', {
        jobs: [job1, job2],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(2);
      // Multi-step job: outputs nested under step names
      const deployStepOutputs = result.jobs[1].steps[0].outputs as any;
      expect(deployStepOutputs.deployed).toBe(true);
      expect(deployStepOutputs.setupData).toEqual({
        init: { env: 'production' },
        config: { port: 8080 },
      });
    });

    it('should flatten cross-job outputs for single-step (run shorthand) jobs', async () => {
      const setupJob = job('setup', {
        runsOn: 'kici:os:linux',
        run: async () => {
          return { env: 'staging', version: '3.0.0' };
        },
      });

      const deployJob = job('deploy', {
        runsOn: 'kici:os:linux',
        needs: [setupJob],
        steps: [
          step('deploy', async (ctx) => {
            const outputs = ctx.jobOutputs(setupJob);
            return { deployedEnv: outputs.env, deployedVersion: outputs.version };
          }),
        ],
      });

      const testWorkflow = workflow('test', {
        jobs: [setupJob, deployJob],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      expect(result.jobs).toHaveLength(2);
      // Single-step job: outputs flattened (no step-name nesting)
      const deployStepOutputs = result.jobs[1].steps[0].outputs as any;
      expect(deployStepOutputs.deployedEnv).toBe('staging');
      expect(deployStepOutputs.deployedVersion).toBe('3.0.0');
    });

    it('should support jobRef.result proxy for cross-job chaining', async () => {
      const setupJob = job('setup', {
        runsOn: 'kici:os:linux',
        run: async () => {
          return { env: 'prod' };
        },
      });

      const deployJob = job('deploy', {
        runsOn: 'kici:os:linux',
        needs: [setupJob],
        steps: [
          step('deploy', async () => {
            // Access via .result proxy
            const env = setupJob.result.env;
            return { targetEnv: env };
          }),
        ],
      });

      const testWorkflow = workflow('test', {
        jobs: [setupJob, deployJob],
      });

      const result = await executeWorkflow(testWorkflow, mockEvent, TEST_REPO_ROOT);

      expect(result.status).toBe('success');
      const deployOutputs = result.jobs[1].steps[0].outputs as any;
      expect(deployOutputs.targetEnv).toBe('prod');
    });
  });
});
