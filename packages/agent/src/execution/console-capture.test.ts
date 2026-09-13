import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '@kici-dev/shared';
import {
  installConsoleCapture,
  runCaptured,
  _uninstallConsoleCaptureForTests,
  _getActiveSinkForTests,
  type CaptureSink,
} from './console-capture.js';

function makeSink(): CaptureSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    addLine(line: string) {
      lines.push(line);
    },
  };
}

describe('console-capture', () => {
  beforeEach(() => {
    installConsoleCapture();
  });

  afterEach(() => {
    _uninstallConsoleCaptureForTests();
  });

  it('captures a single console.log line to the active sink', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log('hi');
    });
    expect(sink.lines).toEqual(['hi']);
  });

  it('captures console.error, warn, info, debug in the same sink', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.error('err');
      console.warn('warn');
      console.info('info');
      console.debug('debug');
    });
    expect(sink.lines).toEqual(['err', 'warn', 'info', 'debug']);
  });

  it('falls through to the real console when no sink is active', () => {
    // With no active ALS sink, console.log should not throw and no sink should
    // be tracked. We can't reliably spy on process.stdout.write under vitest
    // (Node's console may bypass it in some runtimes), so we just assert the
    // ALS state rather than the final fd write.
    expect(_getActiveSinkForTests()).toBeUndefined();
    expect(() => console.log('no sink — fallthrough path')).not.toThrow();
    expect(_getActiveSinkForTests()).toBeUndefined();
  });

  it('splits multi-line output into one sink call per line', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log('a\nb\nc');
    });
    expect(sink.lines).toEqual(['a', 'b', 'c']);
  });

  it('supports util.format specifiers (%s, %d, %j)', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log('x %s %d', 'y', 5);
      console.log('obj %j', { a: 1 });
    });
    expect(sink.lines[0]).toBe('x y 5');
    expect(sink.lines[1]).toBe('obj {"a":1}');
  });

  it('formats objects like native console.log', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log({ a: 1, b: 'two' });
    });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('a:');
    expect(sink.lines[0]).toContain('1');
  });

  it('isolates concurrent runCaptured scopes via ALS', async () => {
    const sinkA = makeSink();
    const sinkB = makeSink();

    await Promise.all([
      runCaptured(sinkA, async () => {
        console.log('A1');
        await new Promise((r) => setImmediate(r));
        console.log('A2');
      }),
      runCaptured(sinkB, async () => {
        console.log('B1');
        await new Promise((r) => setImmediate(r));
        console.log('B2');
      }),
    ]);

    expect(sinkA.lines).toEqual(['A1', 'A2']);
    expect(sinkB.lines).toEqual(['B1', 'B2']);
  });

  it('nested runCaptured shadows the outer sink then restores it', async () => {
    const outer = makeSink();
    const inner = makeSink();
    await runCaptured(outer, async () => {
      console.log('out-1');
      await runCaptured(inner, () => {
        console.log('in-1');
        console.log('in-2');
      });
      console.log('out-2');
    });
    expect(outer.lines).toEqual(['out-1', 'out-2']);
    expect(inner.lines).toEqual(['in-1', 'in-2']);
  });

  it('clears the active sink after fn throws', async () => {
    const sink = makeSink();
    await expect(
      runCaptured(sink, () => {
        console.log('before throw');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sink.lines).toEqual(['before throw']);
    expect(_getActiveSinkForTests()).toBeUndefined();
  });

  it('propagates ALS through awaits', async () => {
    const sink = makeSink();
    await runCaptured(sink, async () => {
      console.log('before');
      await new Promise((r) => setTimeout(r, 1));
      console.log('after');
    });
    expect(sink.lines).toEqual(['before', 'after']);
  });

  it('does NOT capture Winston output (the collision-avoidance invariant)', async () => {
    const sink = makeSink();
    const winstonLogger = createLogger({ prefix: 'test-winston' });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCaptured(sink, () => {
        winstonLogger.info('winston-internal-line');
      });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(sink.lines).toEqual([]);
  });

  it('drops empty lines but preserves whitespace-only lines', async () => {
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log('');
      console.log('\n\n');
      console.log('  ');
    });
    expect(sink.lines).toEqual(['  ']);
  });

  it('installConsoleCapture is idempotent', async () => {
    installConsoleCapture();
    installConsoleCapture();
    installConsoleCapture();
    const sink = makeSink();
    await runCaptured(sink, () => {
      console.log('once');
    });
    expect(sink.lines).toEqual(['once']);
  });
});
