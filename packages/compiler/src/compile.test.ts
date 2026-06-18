import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeConfig } from './execution/index.js';
import { validateConfig } from './validation/index.js';
import { generateLockFile, serializeLockFile } from './lockfile/index.js';
import { SCHEMA_VERSION } from './types.js';

describe('compiler integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory in the package directory so node_modules is accessible
    const packageDir = path.resolve(import.meta.dirname, '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-'));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('compiles a simple workflow config', async () => {
    // Write a test config
    const configPath = path.join(tempDir, 'workflow.ts');
    await fs.writeFile(
      configPath,
      `
      import { workflow, job, step } from '@kici-dev/sdk';

      export default workflow('ci', {
        jobs: [
          job('build', {
            runsOn: 'kici:os:linux',
            steps: [
              step('Build', async ({ $ }) => {
                await $\`echo "Building..."\`;
              }),
            ],
          }),
        ],
      });
      `,
      'utf-8',
    );

    // Execute config
    const { workflows: workflowsWithSource, configPath: absolutePath } =
      await executeConfig(configPath);

    expect(workflowsWithSource).toHaveLength(1);
    expect(workflowsWithSource[0].workflow.name).toBe('ci');
    expect(workflowsWithSource[0].workflow.jobs).toHaveLength(1);

    // Extract workflows for validation
    const workflows = workflowsWithSource.map((w) => w.workflow);

    // Validate
    const validation = validateConfig(workflows, absolutePath);
    expect(validation.valid).toBe(true);

    // Generate lock file with source tracking
    const lockFile = generateLockFile(workflowsWithSource);

    expect(lockFile.schemaVersion).toBe(SCHEMA_VERSION);
    expect(lockFile.workflows).toHaveLength(1);
    expect(lockFile.workflows[0].name).toBe('ci');
    expect(lockFile.workflows[0].jobs).toHaveLength(1);
    expect(lockFile.workflows[0].jobs[0]._type).toBe('static');

    // Verify source tracking
    expect(lockFile.source.file).toContain('workflow.ts');
    expect(lockFile.source.export).toBe('#default');

    // Serialize
    const json = serializeLockFile(lockFile);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('detects circular dependencies', async () => {
    const configPath = path.join(tempDir, 'workflow.ts');
    await fs.writeFile(
      configPath,
      `
      import { workflow, job, step } from '@kici-dev/sdk';

      const buildJob = job('build', {
        runsOn: 'kici:os:linux',
        needs: ['test'], // Circular: build needs test
        steps: [step('Build', async () => {})],
      });

      const testJob = job('test', {
        runsOn: 'kici:os:linux',
        needs: ['build'], // Circular: test needs build
        steps: [step('Test', async () => {})],
      });

      export default workflow('ci', {
        jobs: [buildJob, testJob],
      });
      `,
      'utf-8',
    );

    const { workflows: workflowsWithSource, configPath: absolutePath } =
      await executeConfig(configPath);
    const workflows = workflowsWithSource.map((w) => w.workflow);
    const validation = validateConfig(workflows, absolutePath);

    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors.some((e) => e.code === 'E102')).toBe(true);
    }
  });

  it('marks dynamic matrices correctly', async () => {
    const configPath = path.join(tempDir, 'workflow.ts');
    await fs.writeFile(
      configPath,
      `
      import { workflow, job, step } from '@kici-dev/sdk';

      export default workflow('ci', {
        jobs: [
          job('matrix-job', {
            runsOn: 'kici:os:linux',
            matrix: async ({ $ }) => {
              // Dynamic matrix
              return ['a', 'b', 'c'];
            },
            steps: [step('Run', async () => {})],
          }),
        ],
      });
      `,
      'utf-8',
    );

    const { workflows: workflowsWithSource, configPath: absolutePath } =
      await executeConfig(configPath);
    const workflows = workflowsWithSource.map((w) => w.workflow);
    const validation = validateConfig(workflows, absolutePath);
    expect(validation.valid).toBe(true);

    const lockFile = generateLockFile(workflowsWithSource);
    const job = lockFile.workflows[0].jobs[0];

    expect(job._type).toBe('static');
    if (job._type === 'static') {
      expect(job.matrix?._type).toBe('dynamic');
    }
  });

  it('handles static matrices with values', async () => {
    const configPath = path.join(tempDir, 'workflow.ts');
    await fs.writeFile(
      configPath,
      `
      import { workflow, job, step } from '@kici-dev/sdk';

      export default workflow('ci', {
        jobs: [
          job('matrix-job', {
            runsOn: 'kici:os:linux',
            matrix: { os: ['linux', 'mac'], node: ['18', '20'] },
            steps: [step('Run', async () => {})],
          }),
        ],
      });
      `,
      'utf-8',
    );

    const { workflows: workflowsWithSource, configPath: absolutePath } =
      await executeConfig(configPath);
    const lockFile = generateLockFile(workflowsWithSource);
    const job = lockFile.workflows[0].jobs[0];

    expect(job._type).toBe('static');
    if (job._type === 'static') {
      expect(job.matrix?._type).toBe('static');
      expect(job.matrix?.values).toEqual({ os: ['linux', 'mac'], node: ['18', '20'] });
    }
  });
});
