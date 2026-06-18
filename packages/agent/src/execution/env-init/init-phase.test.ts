import { describe, it, expect, vi } from 'vitest';
import { runInitPhase } from './init-phase.js';
import type { GenericInitConfig, CacheSpec } from '@kici-dev/sdk';
import { TimeoutReason } from '@kici-dev/engine';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

/** Fake zx-style shell: records the command string, resolves or rejects. */
function fakeShell(opts: { exitCode?: number } = {}) {
  const calls: string[] = [];
  const $ = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    // runInitPhase invokes the shell via $`bash -c ${run}` style or $({ shell })
    calls.push([...strings, ...vals.map(String)].join(''));
    if (opts.exitCode && opts.exitCode !== 0) {
      const err: { message: string; exitCode: number } & Error = Object.assign(
        new Error(`exit ${opts.exitCode}`),
        { exitCode: opts.exitCode },
      );
      return Promise.reject(err);
    }
    return Promise.resolve({ exitCode: 0 });
  }) as unknown as typeof import('zx').$;
  return { $, calls };
}

function collectIpc() {
  const msgs: RunnerToAgentMessage[] = [];
  return { send: (m: RunnerToAgentMessage) => msgs.push(m), msgs };
}

describe('runInitPhase', () => {
  it('emits init:0 step.start and step.complete(success) for one init spec', async () => {
    const { $, calls } = fakeShell();
    const { send, msgs } = collectIpc();
    const result = await runInitPhase({
      specs: [{ run: 'echo hi' } as GenericInitConfig],
      shellFor: () => $,
      sendIpc: send,
      stepIndexBase: 5, // after the job's user steps
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const start = msgs.find((m) => m.type === 'step.start');
    expect(start).toMatchObject({ type: 'step.start', stepIndex: 5, step_type: 'init:0' });
    const complete = msgs.find((m) => m.type === 'step.complete');
    expect(complete).toMatchObject({
      type: 'step.complete',
      stepIndex: 5,
      status: 'success',
      step_type: 'init:0',
    });
  });

  it('runs multiple init specs in order with incrementing step_type', async () => {
    const { $, calls } = fakeShell();
    const { send, msgs } = collectIpc();
    const result = await runInitPhase({
      specs: [{ run: 'a' }, { run: 'b' }] as GenericInitConfig[],
      shellFor: () => $,
      sendIpc: send,
      stepIndexBase: 0,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const types = msgs
      .filter((m) => m.type === 'step.start')
      .map((m) => (m as { step_type?: string }).step_type);
    expect(types).toEqual(['init:0', 'init:1']);
  });

  it('fails the job on non-zero exit, marks init:0 failed, and does NOT run later specs', async () => {
    const { $, calls } = fakeShell({ exitCode: 1 });
    const { send, msgs } = collectIpc();
    const result = await runInitPhase({
      specs: [{ run: 'boom' }, { run: 'never' }] as GenericInitConfig[],
      shellFor: () => $,
      sendIpc: send,
      stepIndexBase: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.failedInitIndex).toBe(0);
    expect(calls).toHaveLength(1); // second spec never ran
    const complete = msgs.find((m) => m.type === 'step.complete') as {
      status: string;
      step_type?: string;
      error?: { message: string };
    };
    expect(complete.status).toBe('failed');
    expect(complete.step_type).toBe('init:0');
    expect(complete.error?.message).toMatch(/exit 1/);
  });

  it('restores cache before the command and saves on key miss', async () => {
    const { send } = collectIpc();
    const restore = vi.fn().mockResolvedValue({ hit: false });
    const save = vi.fn().mockResolvedValue(undefined);
    const spec = {
      run: 'mise install',
      cache: { key: 'm', paths: ['~/.local/share/mise'] },
    } as GenericInitConfig;
    const order: string[] = [];
    const restoreSpy = vi.fn(async (s: CacheSpec) => {
      order.push('restore');
      return restore(s);
    });
    const cmdShell = (() => {
      order.push('run');
      return Promise.resolve({ exitCode: 0 });
    }) as unknown as typeof import('zx').$;
    const saveSpy = vi.fn(async (s: CacheSpec) => {
      order.push('save');
      return save(s);
    });
    const result = await runInitPhase({
      specs: [spec],
      shellFor: () => cmdShell,
      sendIpc: send,
      stepIndexBase: 0,
      cache: { restore: restoreSpy, save: saveSpy },
    });
    expect(result.ok).toBe(true);
    expect(restoreSpy).toHaveBeenCalledWith(spec.cache);
    expect(saveSpy).toHaveBeenCalledWith(spec.cache);
    expect(order).toEqual(['restore', 'run', 'save']);
  });

  it('does NOT save when the cache key hit on restore', async () => {
    const { send } = collectIpc();
    const restoreSpy = vi.fn().mockResolvedValue({ hit: true, matchedKey: 'm' });
    const saveSpy = vi.fn().mockResolvedValue(undefined);
    const spec = {
      run: 'mise install',
      cache: { key: 'm', paths: ['~/.local/share/mise'] },
    } as GenericInitConfig;
    const result = await runInitPhase({
      specs: [spec],
      shellFor: () => (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('zx').$,
      sendIpc: send,
      stepIndexBase: 0,
      cache: { restore: restoreSpy, save: saveSpy },
    });
    expect(result.ok).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('skips cache calls entirely when spec has no cache', async () => {
    const { send } = collectIpc();
    const restoreSpy = vi.fn();
    const saveSpy = vi.fn();
    await runInitPhase({
      specs: [{ run: 'echo hi' }],
      shellFor: () => (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('zx').$,
      sendIpc: send,
      stepIndexBase: 0,
      cache: { restore: restoreSpy, save: saveSpy },
    });
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('reads + applies the KICI_ENV/KICI_PATH delta after a successful init', async () => {
    const { send } = collectIpc();
    const applied: Array<{ env: Record<string, string>; path: string[] }> = [];
    const result = await runInitPhase({
      specs: [{ run: 'echo hi' }],
      shellFor: () => (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('zx').$,
      sendIpc: send,
      stepIndexBase: 0,
      env: {
        // P1 port: allocate fresh KICI_ENV/KICI_PATH files, expose, and after the
        // command read+parse+apply+truncate. Test stubs return a fixed delta.
        beginCapture: vi.fn().mockResolvedValue(undefined),
        applyDelta: vi.fn(async () => {
          applied.push({ env: { TOOL_HOME: '/x' }, path: ['/x/bin'] });
        }),
      },
    });
    expect(result.ok).toBe(true);
    expect(applied).toEqual([{ env: { TOOL_HOME: '/x' }, path: ['/x/bin'] }]);
  });

  it('calls beginCapture BEFORE building the shell (so the env snapshot sees KICI_ENV/KICI_PATH)', async () => {
    // The sandbox shell snapshots process.env at construction time, so the P1
    // env files must be pointed-at before shellFor runs — otherwise the init
    // command sees $KICI_ENV/$KICI_PATH as unbound under `set -u`.
    const { send } = collectIpc();
    const order: string[] = [];
    const result = await runInitPhase({
      specs: [{ run: 'echo hi' }],
      shellFor: () => {
        order.push('shellFor');
        return (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('zx').$;
      },
      sendIpc: send,
      stepIndexBase: 0,
      env: {
        beginCapture: vi.fn(async () => {
          order.push('beginCapture');
        }),
        applyDelta: vi.fn().mockResolvedValue(undefined),
      },
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['beginCapture', 'shellFor']);
  });

  it('does NOT apply the env delta when the command failed', async () => {
    const { $ } = fakeShell({ exitCode: 2 });
    const { send } = collectIpc();
    const applyDelta = vi.fn();
    const result = await runInitPhase({
      specs: [{ run: 'boom' }],
      shellFor: () => $,
      sendIpc: send,
      stepIndexBase: 0,
      env: { beginCapture: vi.fn().mockResolvedValue(undefined), applyDelta },
    });
    expect(result.ok).toBe(false);
    expect(applyDelta).not.toHaveBeenCalled();
  });

  it('applies deltas cumulatively across specs (later wins; PATH prepends in order)', async () => {
    const { send } = collectIpc();
    const env: Record<string, string> = {};
    let path = '';
    let call = 0;
    const port = {
      beginCapture: vi.fn().mockResolvedValue(undefined),
      // Simulate P1 applying a per-spec delta into a shared env map.
      applyDelta: vi.fn(async () => {
        if (call++ === 0) {
          env.TOOL = 'a';
          path = '/a:' + path;
        } else {
          env.TOOL = 'b';
          path = '/b:' + path;
        }
      }),
    };
    const result = await runInitPhase({
      specs: [{ run: 'first' }, { run: 'second' }],
      shellFor: () => (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('zx').$,
      sendIpc: send,
      stepIndexBase: 0,
      env: port,
    });
    expect(result.ok).toBe(true);
    expect(env.TOOL).toBe('b'); // later spec overrides
    expect(path).toBe('/b:/a:'); // /b prepended after /a => /b first
  });

  it('fails an init that exceeds its timeout with the P3 timeout reason', async () => {
    const { send, msgs } = collectIpc();
    // shell that never resolves until aborted
    const hangingShell = (() => new Promise(() => {})) as unknown as typeof import('zx').$;
    const result = await runInitPhase({
      specs: [{ run: 'sleep forever', timeout: 20 }],
      shellFor: () => hangingShell,
      sendIpc: send,
      stepIndexBase: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toBe(TimeoutReason.enum.job_timeout);
    const complete = msgs.find((m) => m.type === 'step.complete') as {
      status: string;
      step_type?: string;
    };
    expect(complete.status).toBe('failed');
    expect(complete.step_type).toBe('init:0');
  }, 5_000);

  it('does NOT apply the env delta or save cache when the init timed out', async () => {
    const { send } = collectIpc();
    const applyDelta = vi.fn();
    const saveSpy = vi.fn();
    const restoreSpy = vi.fn().mockResolvedValue({ hit: false });
    const result = await runInitPhase({
      specs: [{ run: 'hang', timeout: 20, cache: { key: 'm', paths: ['~/x'] } }],
      shellFor: () => (() => new Promise(() => {})) as unknown as typeof import('zx').$,
      sendIpc: send,
      stepIndexBase: 0,
      env: { beginCapture: vi.fn().mockResolvedValue(undefined), applyDelta },
      cache: { restore: restoreSpy, save: saveSpy },
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(applyDelta).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  }, 5_000);
});
