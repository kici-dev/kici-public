import { describe, it, expect, beforeEach } from 'vitest';
import { StepLogBuffer } from './step-log-buffer.js';

describe('StepLogBuffer', () => {
  let buffer: StepLogBuffer;

  beforeEach(() => {
    buffer = new StepLogBuffer({ maxLines: 5 });
  });

  const key = { runId: 'run-1', jobId: 'job-1', stepIndex: 0 };

  it('stores lines correctly', () => {
    buffer.addLines(key, ['line 1', 'line 2', 'line 3']);

    const entry = buffer.getLastLines(key);
    expect(entry).toBeDefined();
    expect(entry!.lines).toEqual(['line 1', 'line 2', 'line 3']);
    expect(entry!.totalCount).toBe(3);
  });

  it('evicts oldest lines when exceeding maxLines', () => {
    buffer.addLines(key, ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    buffer.addLines(key, ['line 6', 'line 7']);

    const entry = buffer.getLastLines(key);
    expect(entry).toBeDefined();
    expect(entry!.lines).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    expect(entry!.lines).toHaveLength(5);
  });

  it('totalCount tracks total lines added (not just retained)', () => {
    buffer.addLines(key, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    const entry = buffer.getLastLines(key);
    expect(entry!.totalCount).toBe(7);
    expect(entry!.lines).toHaveLength(5);
  });

  it('strips ANSI codes from stored lines', () => {
    buffer.addLines(key, [
      '\x1b[31mERROR\x1b[0m: something failed',
      '\x1b[32mOK\x1b[0m: all good',
      '\x1b[1m\x1b[33mWARN\x1b[0m: watch out',
    ]);

    const entry = buffer.getLastLines(key);
    expect(entry!.lines).toEqual(['ERROR: something failed', 'OK: all good', 'WARN: watch out']);
  });

  it('returns undefined for unknown keys', () => {
    const entry = buffer.getLastLines({ runId: 'unknown', jobId: 'unknown', stepIndex: 99 });
    expect(entry).toBeUndefined();
  });

  it('cleanup(runId) removes all entries for that run', () => {
    const key1 = { runId: 'run-1', jobId: 'job-1', stepIndex: 0 };
    const key2 = { runId: 'run-1', jobId: 'job-1', stepIndex: 1 };
    const key3 = { runId: 'run-2', jobId: 'job-1', stepIndex: 0 };

    buffer.addLines(key1, ['line 1']);
    buffer.addLines(key2, ['line 2']);
    buffer.addLines(key3, ['line 3']);

    buffer.cleanup('run-1');

    expect(buffer.getLastLines(key1)).toBeUndefined();
    expect(buffer.getLastLines(key2)).toBeUndefined();
    expect(buffer.getLastLines(key3)).toBeDefined();
    expect(buffer.getLastLines(key3)!.lines).toEqual(['line 3']);
  });

  it('tracks multiple steps in the same run independently', () => {
    const step0 = { runId: 'run-1', jobId: 'job-1', stepIndex: 0 };
    const step1 = { runId: 'run-1', jobId: 'job-1', stepIndex: 1 };

    buffer.addLines(step0, ['step-0 line 1', 'step-0 line 2']);
    buffer.addLines(step1, ['step-1 line 1']);

    const entry0 = buffer.getLastLines(step0);
    const entry1 = buffer.getLastLines(step1);

    expect(entry0!.lines).toEqual(['step-0 line 1', 'step-0 line 2']);
    expect(entry0!.totalCount).toBe(2);

    expect(entry1!.lines).toEqual(['step-1 line 1']);
    expect(entry1!.totalCount).toBe(1);
  });

  it('uses default maxLines of 20 when not specified', () => {
    const defaultBuffer = new StepLogBuffer();
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);

    defaultBuffer.addLines(key, lines);

    const entry = defaultBuffer.getLastLines(key);
    expect(entry!.lines).toHaveLength(20);
    expect(entry!.totalCount).toBe(25);
    expect(entry!.lines[0]).toBe('line 6');
    expect(entry!.lines[19]).toBe('line 25');
  });

  it('returns a copy of lines (not a reference)', () => {
    buffer.addLines(key, ['original']);

    const entry1 = buffer.getLastLines(key);
    entry1!.lines.push('mutated');

    const entry2 = buffer.getLastLines(key);
    expect(entry2!.lines).toEqual(['original']);
  });

  it('handles incremental addLines calls', () => {
    buffer.addLines(key, ['line 1']);
    buffer.addLines(key, ['line 2']);
    buffer.addLines(key, ['line 3']);

    const entry = buffer.getLastLines(key);
    expect(entry!.lines).toEqual(['line 1', 'line 2', 'line 3']);
    expect(entry!.totalCount).toBe(3);
  });
});
