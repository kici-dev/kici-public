import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { buildStepEnvFileHooks } from './workflow-runner.js';

const noopSend = () => {};

describe('buildStepEnvFileHooks — per-step delta files', () => {
  const savedEnv = process.env.KICI_ENV;
  const savedPath = process.env.KICI_PATH;
  afterEach(() => {
    process.env.KICI_ENV = savedEnv;
    process.env.KICI_PATH = savedPath;
  });

  it('gives each step index its own distinct env/path file pair', async () => {
    const hooks = buildStepEnvFileHooks(new Set(), noopSend);
    await hooks.beforeStepEnvFiles(0);
    const env0 = process.env.KICI_ENV;
    const path0 = process.env.KICI_PATH;
    await hooks.beforeStepEnvFiles(1);
    const env1 = process.env.KICI_ENV;
    const path1 = process.env.KICI_PATH;

    expect(env0).toBeDefined();
    expect(env1).toBeDefined();
    expect(env0).not.toBe(env1);
    expect(path0).not.toBe(path1);
  });

  it('applying one step does not truncate another step in-flight file', async () => {
    const hooks = buildStepEnvFileHooks(new Set(), noopSend);
    await hooks.beforeStepEnvFiles(0);
    const env0 = process.env.KICI_ENV!;
    await hooks.beforeStepEnvFiles(1);
    const env1 = process.env.KICI_ENV!;

    // Step 1 wrote a delta to its own file; step 0's apply must not touch it.
    await writeFile(env1, 'STEP1_KEY=value1\n');
    await writeFile(env0, 'STEP0_KEY=value0\n');

    await hooks.afterStepApplyEnvFiles(0); // applies + releases step 0 only

    // Step 1's file is untouched (still holds its delta).
    expect(await readFile(env1, 'utf8')).toContain('STEP1_KEY=value1');
    // Step 0's delta landed in process.env.
    expect(process.env.STEP0_KEY).toBe('value0');
    expect(process.env.STEP1_KEY).toBeUndefined();
    delete process.env.STEP0_KEY;
  });
});
