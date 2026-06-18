import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentLogChunk } from '@kici-dev/engine';
import { LogStreamer, BACKPRESSURE_THRESHOLD } from './log-streamer.js';
import {
  logBackpressureActive,
  logBackpressureEventsTotal,
  logLinesDroppedTotal,
} from '../metrics/prometheus.js';

describe('LogStreamer', () => {
  let send: ReturnType<typeof vi.fn<(msg: AgentLogChunk) => void>>;
  let streamer: LogStreamer;

  const baseOptions = {
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    flushIntervalMs: 100,
    flushLineThreshold: 50,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn<(msg: AgentLogChunk) => void>();
    streamer = new LogStreamer({ ...baseOptions, send });
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
  });

  it('lines below threshold do not flush until timer fires', () => {
    streamer.addLine('line 1');
    streamer.addLine('line 2');

    // No flush yet - below threshold and timer hasn't fired
    expect(send).not.toHaveBeenCalled();

    // Advance timer to trigger flush
    vi.advanceTimersByTime(100);

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.lines).toEqual(['line 1', 'line 2']);
  });

  it('adding 50+ lines triggers immediate flush', () => {
    for (let i = 0; i < 50; i++) {
      streamer.addLine(`line ${i}`);
    }

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.lines).toHaveLength(50);
  });

  it('timer-based flush at 100ms sends buffered lines', () => {
    streamer.addLine('hello');

    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].lines).toEqual(['hello']);
  });

  it('flush produces correctly shaped log.chunk message', () => {
    streamer.addLine('test line');
    vi.advanceTimersByTime(100);

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];

    expect(msg.type).toBe('log.chunk');
    expect(msg.messageId).toBeDefined();
    expect(msg.runId).toBe('run-1');
    expect(msg.jobId).toBe('job-1');
    expect(msg.stepIndex).toBe(0);
    expect(msg.lines).toEqual(['test line']);
    expect(typeof msg.timestamp).toBe('number');
  });

  it('max log size truncation: truncation message added and further lines dropped', () => {
    const smallStreamer = new LogStreamer({
      ...baseOptions,
      send,
      maxLogSizeBytes: 100,
      flushLineThreshold: 1000, // High threshold so we control flushing
    });

    // Add lines until we exceed 100 bytes
    for (let i = 0; i < 20; i++) {
      smallStreamer.addLine(`line-${i}-with-some-padding`);
    }

    // One more line should trigger truncation
    smallStreamer.addLine('this should be dropped');
    smallStreamer.addLine('this should also be dropped');

    // Flush and check
    smallStreamer.destroy();

    // Find the truncation message
    const allLines = send.mock.calls.flatMap((call) => call[0].lines);
    const truncationLine = allLines.find((l: string) => l.includes('[TRUNCATED:'));
    expect(truncationLine).toBeDefined();
    expect(truncationLine).toContain('exceeded 100 bytes');

    // 'this should be dropped' and 'this should also be dropped' should not appear
    expect(allLines).not.toContain('this should be dropped');
    expect(allLines).not.toContain('this should also be dropped');
  });

  it('destroy() flushes remaining buffer', () => {
    streamer.addLine('remaining line');
    expect(send).not.toHaveBeenCalled();

    streamer.destroy();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].lines).toEqual(['remaining line']);
  });

  it('multiple flushes produce separate messages (buffer empties after each)', () => {
    // First batch
    for (let i = 0; i < 50; i++) {
      streamer.addLine(`batch1-${i}`);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].lines).toHaveLength(50);

    // Second batch
    for (let i = 0; i < 50; i++) {
      streamer.addLine(`batch2-${i}`);
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].lines).toHaveLength(50);
    expect(send.mock.calls[1][0].lines[0]).toBe('batch2-0');
  });

  it('getTotalBytes() tracks correctly', () => {
    expect(streamer.getTotalBytes()).toBe(0);

    streamer.addLine('hello'); // 5 bytes
    expect(streamer.getTotalBytes()).toBe(5);

    streamer.addLine('world'); // 5 bytes
    expect(streamer.getTotalBytes()).toBe(10);
  });

  it('getTotalBytes() tracks multibyte characters correctly', () => {
    streamer.addLine('\u00e9'); // e-acute is 2 bytes in UTF-8
    expect(streamer.getTotalBytes()).toBe(2);
  });

  it('empty flush is no-op (no message sent)', () => {
    streamer.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('scheduleFlush does not create multiple timers', () => {
    streamer.addLine('line 1');
    streamer.addLine('line 2');
    streamer.addLine('line 3');

    // Only one timer, only one flush after 100ms
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].lines).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('uses default values when not provided', () => {
    const defaultStreamer = new LogStreamer({
      send,
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
    });

    // Should not throw and use defaults
    defaultStreamer.addLine('test');
    defaultStreamer.destroy();

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('LogStreamer backpressure', () => {
  let send: ReturnType<typeof vi.fn<(msg: AgentLogChunk) => void>>;

  const baseOptions = {
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    flushIntervalMs: 100,
    flushLineThreshold: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn<(msg: AgentLogChunk) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default behavior (no getBufferedAmount)', () => {
    it('sends normally without backpressure checks', () => {
      const streamer = new LogStreamer({ ...baseOptions, send });

      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].lines).toHaveLength(5);
      streamer.destroy();
    });
  });

  describe('no backpressure when buffer is below threshold', () => {
    it('sends normally when getBufferedAmount returns 0', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(0);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].lines).toHaveLength(5);
      expect(streamer.getDroppedCount()).toBe(0);
      streamer.destroy();
    });

    it('sends normally when getBufferedAmount is below threshold', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD - 1);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }

      expect(send).toHaveBeenCalledTimes(1);
      expect(streamer.getDroppedCount()).toBe(0);
      streamer.destroy();
    });
  });

  describe('drop mode', () => {
    it('discards lines when backpressure is detected', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      // These lines will be buffered, then flushed (which triggers drop)
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }

      // Flush was called (threshold reached), but lines were dropped
      expect(send).not.toHaveBeenCalled();
      expect(streamer.getDroppedCount()).toBe(5);
      streamer.destroy();
    });

    it('emits drop marker on next successful send', () => {
      let buffered = BACKPRESSURE_THRESHOLD + 1;
      const getBufferedAmount = vi.fn(() => buffered);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      // First batch: backpressure active, lines dropped
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`dropped-${i}`);
      }
      expect(send).not.toHaveBeenCalled();
      expect(streamer.getDroppedCount()).toBe(5);

      // Clear backpressure
      buffered = 0;

      // Second batch: should send with drop marker prepended
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`sent-${i}`);
      }

      expect(send).toHaveBeenCalledTimes(1);
      const msg = send.mock.calls[0][0];
      expect(msg.lines[0]).toBe('[5 lines dropped due to backpressure]');
      expect(msg.lines.slice(1)).toEqual(['sent-0', 'sent-1', 'sent-2', 'sent-3', 'sent-4']);
      expect(streamer.getDroppedCount()).toBe(0);
      streamer.destroy();
    });
  });

  describe('pause mode', () => {
    it('calls onBackpressure callback when threshold exceeded', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const onBackpressure = vi.fn();
      const onWsDrain = vi.fn();
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'pause',
        onBackpressure,
        onWsDrain,
      });

      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }

      expect(onBackpressure).toHaveBeenCalledTimes(1);
      expect(streamer.isPaused()).toBe(true);
      // Lines are not sent (kept in buffer for resume)
      expect(send).not.toHaveBeenCalled();
      streamer.destroy();
    });

    it('calls onBackpressureClear on drain and resumes sending', () => {
      let buffered = BACKPRESSURE_THRESHOLD + 1;
      const getBufferedAmount = vi.fn(() => buffered);
      const onBackpressure = vi.fn();
      const onBackpressureClear = vi.fn();
      let drainCallback: (() => void) | null = null;
      const onWsDrain = vi.fn((cb: () => void) => {
        drainCallback = cb;
      });

      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'pause',
        onBackpressure,
        onBackpressureClear,
        onWsDrain,
      });

      // Trigger backpressure
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }
      expect(streamer.isPaused()).toBe(true);
      expect(onBackpressure).toHaveBeenCalledTimes(1);
      expect(onWsDrain).toHaveBeenCalledTimes(1);

      // Simulate drain event (backpressure clears)
      buffered = 0;
      drainCallback!();

      expect(onBackpressureClear).toHaveBeenCalledTimes(1);
      expect(streamer.isPaused()).toBe(false);
      // Lines should now be sent
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].lines).toHaveLength(5);
      streamer.destroy();
    });

    it('safety timeout switches to drop after 30s and resumes', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const onBackpressure = vi.fn();
      const onBackpressureClear = vi.fn();
      const onWsDrain = vi.fn();

      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'pause',
        onBackpressure,
        onBackpressureClear,
        onWsDrain,
      });

      // Trigger backpressure
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`line ${i}`);
      }
      expect(streamer.isPaused()).toBe(true);

      // Advance time past safety timeout (30s)
      vi.advanceTimersByTime(30_000);

      // Should have cleared backpressure and dropped the lines
      expect(streamer.isPaused()).toBe(false);
      expect(onBackpressureClear).toHaveBeenCalledTimes(1);
      expect(streamer.getDroppedCount()).toBe(5);

      streamer.destroy();
    });

    it('does not call onBackpressure multiple times while already paused', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const onBackpressure = vi.fn();
      const onWsDrain = vi.fn();

      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'pause',
        onBackpressure,
        onWsDrain,
        flushLineThreshold: 3,
      });

      // First batch triggers backpressure
      streamer.addLine('a');
      streamer.addLine('b');
      streamer.addLine('c');
      expect(onBackpressure).toHaveBeenCalledTimes(1);

      // Timer fires, tries to flush again -- should not call onBackpressure again
      vi.advanceTimersByTime(100);
      expect(onBackpressure).toHaveBeenCalledTimes(1);

      streamer.destroy();
    });
  });

  describe('destroy with backpressure', () => {
    it('force-sends remaining buffer on destroy even during backpressure', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      // These lines get dropped during normal flush
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`dropped-${i}`);
      }
      expect(send).not.toHaveBeenCalled();

      // Add more lines that haven't been flushed yet (below threshold)
      streamer.addLine('final-1');
      streamer.addLine('final-2');

      // Destroy should force-send remaining with drop marker
      streamer.destroy();

      expect(send).toHaveBeenCalledTimes(1);
      const msg = send.mock.calls[0][0];
      expect(msg.lines[0]).toBe('[5 lines dropped due to backpressure]');
      expect(msg.lines).toContain('final-1');
      expect(msg.lines).toContain('final-2');
    });

    it('emits drop marker on destroy when all lines were dropped', () => {
      const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
      const streamer = new LogStreamer({
        ...baseOptions,
        send,
        getBufferedAmount,
        backpressureMode: 'drop',
      });

      // All lines get dropped
      for (let i = 0; i < 5; i++) {
        streamer.addLine(`dropped-${i}`);
      }

      streamer.destroy();

      expect(send).toHaveBeenCalledTimes(1);
      const msg = send.mock.calls[0][0];
      expect(msg.lines).toEqual(['[5 lines dropped due to backpressure]']);
    });
  });
});

describe('LogStreamer Prometheus backpressure counters', () => {
  let send: ReturnType<typeof vi.fn<(msg: AgentLogChunk) => void>>;
  let eventsSpy: ReturnType<typeof vi.spyOn>;
  let activeSpy: ReturnType<typeof vi.spyOn>;
  let droppedSpy: ReturnType<typeof vi.spyOn>;

  const baseOptions = {
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    flushIntervalMs: 100,
    flushLineThreshold: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn<(msg: AgentLogChunk) => void>();
    eventsSpy = vi.spyOn(logBackpressureEventsTotal, 'add');
    activeSpy = vi.spyOn(logBackpressureActive, 'add');
    droppedSpy = vi.spyOn(logLinesDroppedTotal, 'add');
  });

  afterEach(() => {
    eventsSpy.mockRestore();
    activeSpy.mockRestore();
    droppedSpy.mockRestore();
    vi.useRealTimers();
  });

  it('pause rising edge increments events+active exactly once even on repeated flushes', () => {
    const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
    const streamer = new LogStreamer({
      ...baseOptions,
      send,
      getBufferedAmount,
      backpressureMode: 'pause',
      onWsDrain: vi.fn(),
      flushLineThreshold: 3,
    });

    // First batch triggers pause.
    streamer.addLine('a');
    streamer.addLine('b');
    streamer.addLine('c');
    // Timer-driven flush, still paused.
    vi.advanceTimersByTime(100);
    // More lines while paused.
    streamer.addLine('d');
    streamer.addLine('e');
    streamer.addLine('f');

    const pauseEventCalls = eventsSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'pause',
    );
    const pauseActiveCalls = activeSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'pause',
    );
    expect(pauseEventCalls).toHaveLength(1);
    expect(pauseEventCalls[0][0]).toBe(1);
    expect(pauseActiveCalls).toHaveLength(1);
    expect(pauseActiveCalls[0][0]).toBe(1);

    streamer.destroy();
  });

  it('pause drain resume decrements active exactly once', () => {
    let buffered = BACKPRESSURE_THRESHOLD + 1;
    const getBufferedAmount = vi.fn(() => buffered);
    let drainCallback: (() => void) | null = null;
    const onWsDrain = vi.fn((cb: () => void) => {
      drainCallback = cb;
    });

    const streamer = new LogStreamer({
      ...baseOptions,
      send,
      getBufferedAmount,
      backpressureMode: 'pause',
      onWsDrain,
    });

    for (let i = 0; i < 5; i++) {
      streamer.addLine(`line ${i}`);
    }
    // active(+1 pause) on rising edge.
    buffered = 0;
    drainCallback!();

    const pauseActiveCalls = activeSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'pause',
    );
    // One +1 on entry, one -1 on drain.
    expect(pauseActiveCalls).toEqual([
      [1, { mode: 'pause' }],
      [-1, { mode: 'pause' }],
    ]);

    streamer.destroy();
  });

  it('drop mode rising edge increments events+active once for a burst', () => {
    const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
    const streamer = new LogStreamer({
      ...baseOptions,
      send,
      getBufferedAmount,
      backpressureMode: 'drop',
    });

    // Two threshold-reached flushes, each would trip the drop path.
    for (let i = 0; i < 5; i++) streamer.addLine(`a${i}`);
    for (let i = 0; i < 5; i++) streamer.addLine(`b${i}`);

    const dropEventCalls = eventsSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'drop',
    );
    const dropActiveCalls = activeSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'drop',
    );
    expect(dropEventCalls).toHaveLength(1);
    expect(dropActiveCalls).toEqual([[1, { mode: 'drop' }]]);

    streamer.destroy();
  });

  it('drop marker emit records lines dropped + clears drop-active gauge', () => {
    let buffered = BACKPRESSURE_THRESHOLD + 1;
    const getBufferedAmount = vi.fn(() => buffered);
    const streamer = new LogStreamer({
      ...baseOptions,
      send,
      getBufferedAmount,
      backpressureMode: 'drop',
    });

    for (let i = 0; i < 5; i++) streamer.addLine(`drop-${i}`);
    expect(streamer.getDroppedCount()).toBe(5);

    // Backpressure clears — next flush emits marker and records loss.
    buffered = 0;
    for (let i = 0; i < 5; i++) streamer.addLine(`keep-${i}`);

    expect(droppedSpy).toHaveBeenCalledWith(5);
    // Active must flip back to 0 (drop mode exit).
    const dropActiveCalls = activeSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'drop',
    );
    expect(dropActiveCalls).toEqual([
      [1, { mode: 'drop' }],
      [-1, { mode: 'drop' }],
    ]);

    streamer.destroy();
  });

  it('pause safety timeout decrements active exactly once', () => {
    const getBufferedAmount = vi.fn().mockReturnValue(BACKPRESSURE_THRESHOLD + 1);
    const streamer = new LogStreamer({
      ...baseOptions,
      send,
      getBufferedAmount,
      backpressureMode: 'pause',
      onWsDrain: vi.fn(),
    });

    for (let i = 0; i < 5; i++) streamer.addLine(`line ${i}`);
    vi.advanceTimersByTime(30_000);

    const pauseActiveCalls = activeSpy.mock.calls.filter(
      (call) => (call[1] as { mode: string } | undefined)?.mode === 'pause',
    );
    expect(pauseActiveCalls).toEqual([
      [1, { mode: 'pause' }],
      [-1, { mode: 'pause' }],
    ]);

    streamer.destroy();
  });
});
