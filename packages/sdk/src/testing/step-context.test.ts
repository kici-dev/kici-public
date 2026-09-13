import { describe, it, expect, afterEach } from 'vitest';
import { stat } from 'node:fs/promises';
import type { StepContext } from '../context.js';
import { defineEvent } from '../events/define-event.js';
import { z } from 'zod';
import { createTestStepContext, type TestStepContext } from './step-context.js';

describe('createTestStepContext', () => {
  let handle: TestStepContext | undefined;
  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
  });

  it('returns a context with sensible defaults and zero required args', () => {
    handle = createTestStepContext();
    const { ctx } = handle;
    expect(ctx.isTestRun).toBe(false);
    expect(ctx.workflow.name).toBe('test-workflow');
    expect(ctx.job.name).toBe('test-job');
    expect(ctx.job.runsOn).toBe('local');
    expect(typeof ctx.$).toBe('function');
    expect(ctx.inputs).toEqual({});
    expect(ctx.dispatchInputs).toEqual({});
  });

  it('runs real shell commands via ctx.$ scoped to repoRoot', async () => {
    handle = createTestStepContext({ repoRoot: process.cwd() });
    const out = (await handle.ctx.$`echo harness-ok`).stdout.trim();
    expect(out).toBe('harness-ok');
  });

  it('records emit calls instead of dropping them, and returns the local delivery id', async () => {
    handle = createTestStepContext();
    const receipt = await handle.ctx.emit(
      'deploy-done',
      { env: 'prod' },
      { target: { repos: ['o/r'] } },
    );
    expect(receipt).toEqual({ deliveryId: 'local-test-noop' });
    expect(handle.emitCalls).toHaveLength(1);
    expect(handle.emitCalls[0]).toEqual({
      eventName: 'deploy-done',
      payload: { env: 'prod' },
      options: { target: { repos: ['o/r'] } },
    });
  });

  it('records a defineEvent() definition emit under its resolved string name', async () => {
    handle = createTestStepContext();
    const deployComplete = defineEvent('deploy-complete', z.object({ env: z.string() }));
    await handle.ctx.emit(deployComplete, { env: 'prod' });
    expect(handle.emitCalls).toHaveLength(1);
    expect(handle.emitCalls[0].eventName).toBe('deploy-complete');
    expect(handle.emitCalls[0].payload).toEqual({ env: 'prod' });
  });

  it('exposes seeded secrets via ctx.secrets', async () => {
    handle = createTestStepContext({ secrets: { flat: { TOKEN: 'abc' } } });
    expect(handle.ctx.secrets.has('TOKEN')).toBe(true);
    expect(await handle.ctx.secrets.get('TOKEN')).toBe('abc');
  });

  it('flattens context secrets into the flat map (matches local-runner merge)', async () => {
    handle = createTestStepContext({ secrets: { contexts: { prod: { DEPLOY_KEY: 'xyz' } } } });
    expect(await handle.ctx.secrets.get('DEPLOY_KEY')).toBe('xyz');
  });

  it('lets a caller override any StepContext member (inject a fake $ for pure-logic tests)', () => {
    const fake$ = (() => ({ stdout: 'stubbed' })) as unknown as StepContext['$'];
    handle = createTestStepContext({ $: fake$ });
    expect(handle.ctx.$).toBe(fake$);
  });

  it('rejects unavailable orchestrator-backed APIs by default', async () => {
    handle = createTestStepContext();
    await expect(handle.ctx.attestProvenance({} as never)).rejects.toThrow(/not available/);
    await expect(handle.ctx.kici.oidc.token({} as never)).rejects.toThrow(/not available/);
    await expect(handle.ctx.artifacts.upload('a', ['x'])).rejects.toThrow(/not available/);
  });

  it('dispose() tears down secrets state and is safe to call twice', async () => {
    handle = createTestStepContext();
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it('setEnv / addPath mutate ctx.env', () => {
    handle = createTestStepContext();
    handle.ctx.setEnv('FOO', 'bar');
    expect(handle.ctx.env.FOO).toBe('bar');
    handle.ctx.addPath('/opt/bin');
    expect(handle.ctx.env.PATH?.startsWith('/opt/bin:')).toBe(true);
  });

  it('dispose() restores process.env mutated by setEnv / addPath (no leak)', async () => {
    const pathBefore = process.env.PATH;
    handle = createTestStepContext();
    handle.ctx.setEnv('KICI_TEST_LEAK_PROBE', 'x');
    handle.ctx.addPath('/opt/bin');
    // While live, the real process.env reflects the mutations.
    expect(process.env.KICI_TEST_LEAK_PROBE).toBe('x');
    expect(process.env.PATH?.startsWith('/opt/bin:')).toBe(true);
    await handle.dispose();
    handle = undefined;
    // After dispose, no pollution leaks into the shared process.env.
    expect(process.env.KICI_TEST_LEAK_PROBE).toBeUndefined();
    expect(process.env.PATH?.startsWith('/opt/bin:')).toBe(false);
    expect(process.env.PATH).toBe(pathBefore);
  });

  it('setEnv restores a pre-existing process.env value on dispose (no clobber)', async () => {
    process.env.KICI_TEST_PREEXISTING_ENV = 'original';
    try {
      handle = createTestStepContext();
      handle.ctx.setEnv('KICI_TEST_PREEXISTING_ENV', 'overwritten');
      expect(process.env.KICI_TEST_PREEXISTING_ENV).toBe('overwritten');
      await handle.dispose();
      handle = undefined;
      expect(process.env.KICI_TEST_PREEXISTING_ENV).toBe('original');
    } finally {
      delete process.env.KICI_TEST_PREEXISTING_ENV;
    }
  });

  it('secrets cleanup does not delete a pre-existing process.env var (no silent data loss)', async () => {
    process.env.KICI_TEST_PREEXISTING = 'keep';
    try {
      handle = createTestStepContext({ secrets: { flat: { K: 'secret-value' } } });
      await handle.ctx.secrets.exposeFile('KICI_TEST_PREEXISTING', { sources: ['K'] });
      await handle.dispose();
      handle = undefined;
      expect(process.env.KICI_TEST_PREEXISTING).toBe('keep');
    } finally {
      delete process.env.KICI_TEST_PREEXISTING;
    }
  });
});

describe('ctx.mktemp / ctx.mktempFile (test builder)', () => {
  let handle: TestStepContext | undefined;
  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
  });

  it('mktemp(label) returns a handle whose dir exists, then cleanup() removes it', async () => {
    handle = createTestStepContext();
    const h = await handle.ctx.mktemp('sdktest');
    expect((await stat(h.path)).isDirectory()).toBe(true);
    await h.cleanup();
    await expect(stat(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanup() is idempotent — a second call is a no-op', async () => {
    handle = createTestStepContext();
    const h = await handle.ctx.mktemp('sdktest');
    await h.cleanup();
    await expect(h.cleanup()).resolves.toBeUndefined();
  });

  it('mktemp() with no label defaults to a sanitized step id and still works', async () => {
    handle = createTestStepContext();
    const h = await handle.ctx.mktemp();
    expect((await stat(h.path)).isDirectory()).toBe(true);
    await h.cleanup();
  });

  it('mktempFile() returns an existing file path', async () => {
    handle = createTestStepContext();
    const h = await handle.ctx.mktempFile();
    expect((await stat(h.path)).isFile()).toBe(true);
    await h.cleanup();
    await expect(stat(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dispose() drains still-live temp dirs', async () => {
    handle = createTestStepContext();
    const h = await handle.ctx.mktemp('sdktest');
    expect((await stat(h.path)).isDirectory()).toBe(true);
    await handle.dispose();
    handle = undefined;
    await expect(stat(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
