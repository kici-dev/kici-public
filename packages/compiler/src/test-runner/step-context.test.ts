import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createStepContext } from './step-context.js';

describe('createStepContext', () => {
  it('pins ctx.$ to the provided repoRoot, not process.cwd()', async () => {
    // A throwaway directory that is not the current cwd. The scoped shell
    // must resolve `pwd` against this dir, proving the cwd override on the
    // zx shell took effect (local-dispatch parity with agent execution).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-step-ctx-'));
    try {
      const ctx = createStepContext(
        { name: 'test-wf' },
        { name: 'test-job', runsOn: 'local' },
        tmp,
      );

      const result = await ctx.$`pwd`;
      // On macOS, /tmp is a symlink to /private/tmp, so compare via realpath.
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(tmp));
      expect(fs.realpathSync(result.stdout.trim())).not.toBe(fs.realpathSync(process.cwd()));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes an unaborted AbortSignal by default', () => {
    const ctx = createStepContext(
      { name: 'test-wf' },
      { name: 'test-job', runsOn: 'local' },
      process.cwd(),
    );
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  it('exposes the provided AbortSignal and reflects its aborted state', () => {
    const controller = new AbortController();
    const ctx = createStepContext(
      { name: 'test-wf' },
      { name: 'test-job', runsOn: 'local' },
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      controller.signal,
    );
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  it('propagates rawPayload + provider when supplied', () => {
    const rawPayload = { client_payload: { foo: 'bar' }, action: 'cdn-bundle' };
    const ctx = createStepContext(
      { name: 'test-wf' },
      { name: 'test-job', runsOn: 'local' },
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      rawPayload,
      'github',
    );

    expect(ctx.rawPayload).toEqual(rawPayload);
    expect(ctx.provider).toBe('github');
  });

  it('leaves rawPayload + provider undefined when not supplied', () => {
    const ctx = createStepContext(
      { name: 'test-wf' },
      { name: 'test-job', runsOn: 'local' },
      process.cwd(),
    );

    expect(ctx.rawPayload).toBeUndefined();
    expect(ctx.provider).toBeUndefined();
  });
});
