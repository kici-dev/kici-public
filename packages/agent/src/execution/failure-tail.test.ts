import { describe, expect, it } from 'vitest';
import { KEEP_END_TRUNCATION_MARKER, TimeoutReason } from '@kici-dev/engine';
import {
  FAILURE_TAIL_MAX_CHARS,
  FAILURE_TAIL_MAX_LINES,
  boundJobFailureData,
  failureDetail,
  formatFailureTail,
  formatInitFailureMessage,
  visibleLines,
} from './failure-tail.js';

describe('visibleLines', () => {
  it('keeps what a terminal shows: the last redraw of each line, without color codes', () => {
    expect(visibleLines('\u001b[32mok\u001b[0m\n 10%\r 50%\r100%\r\nnext\r\n')).toEqual([
      'ok',
      '100%',
      'next',
      '',
    ]);
  });
});

describe('formatFailureTail', () => {
  it('keeps the last lines of multi-line output, within the character cap', () => {
    const output = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const out = formatFailureTail(`${output}\n\n`);
    // fails-when: the whole output becomes the job error
    expect(out.split('\n')).toHaveLength(FAILURE_TAIL_MAX_LINES);
    expect(out.endsWith('line 399')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(FAILURE_TAIL_MAX_CHARS);
  });

  it('keeps the end of long multi-line output and the start of one long line', () => {
    const multi = formatFailureTail(`head\n${'b'.repeat(5_000)}END`);
    expect(multi.startsWith(KEEP_END_TRUNCATION_MARKER)).toBe(true);
    expect(multi.endsWith('END')).toBe(true);
    const single = formatFailureTail(`Lock file is out of date: ${'x'.repeat(5_000)}`);
    // breaks-if-wrong: a one-line error keeps its cause, which is at the start
    expect(single.startsWith('Lock file is out of date: ')).toBe(true);
    expect(single.length).toBe(FAILURE_TAIL_MAX_CHARS);
  });

  it('masks before cutting, so no fragment of a secret survives the cut', () => {
    const secret = 'SECRET-TOKEN-ABCDEFG';
    const keep = FAILURE_TAIL_MAX_CHARS - KEEP_END_TRUNCATION_MARKER.length;
    // The cut lands inside the secret: its last 5 characters are within the kept end.
    const text = `header\n${'a'.repeat(100)}${secret}${'b'.repeat(keep - 5)}`;
    const mask = (line: string) => line.split(secret).join('***');
    // Positive control: without the mask, the cut really leaves a fragment.
    expect(formatFailureTail(text)).toContain('CDEFG');
    // fails-when: masking runs after the cut, so the fragment no longer matches the secret
    expect(formatFailureTail(text, { mask })).not.toContain('CDEFG');
  });

  it('is idempotent', () => {
    const samples = [
      '\u001b[31merror\u001b[0m\r\nfoo\rbar\n\n',
      Array.from({ length: 60 }, (_, i) => `l${i} ${'z'.repeat(i * 7)}`).join('\n'),
      `one long line ${'q'.repeat(4_000)}`,
      '',
    ];
    for (const sample of samples) {
      const once = formatFailureTail(sample);
      // fails-when: a second pass (the job-runner bound) changes an already-bounded error
      expect(formatFailureTail(once)).toBe(once);
    }
  });
});

describe('failureDetail', () => {
  it('reads stderr, then stdout, then the error message', () => {
    expect(failureDetail({ stderr: 'boom\n', stdout: 'out' })).toBe('boom');
    expect(failureDetail({ stderr: '\n', stdout: 'out\n' })).toBe('out');
    expect(failureDetail(new Error('plain failure'))).toBe('plain failure');
  });
});

describe('formatInitFailureMessage', () => {
  it('names the init, the exit code and the detail within the cap', () => {
    expect(formatInitFailureMessage({ index: 0, exitCode: 3, detail: 'checksum mismatch' })).toBe(
      'init[0] failed (exit 3): checksum mismatch',
    );
    expect(
      formatInitFailureMessage({
        index: 1,
        reason: TimeoutReason.enum.job_timeout,
        detail: 'slow',
      }),
    ).toBe('init[1] job_timeout: slow');
    expect(formatInitFailureMessage({ index: 2, detail: '' })).toBe('init[2] failed');
    const long = formatInitFailureMessage({
      index: 0,
      exitCode: 1,
      detail: formatFailureTail(Array.from({ length: 30 }, () => 'w'.repeat(200)).join('\n')),
    });
    // fails-when: the head plus a full-size detail passes the cap, so the job-runner bound cuts the head off
    expect(long.length).toBeLessThanOrEqual(FAILURE_TAIL_MAX_CHARS);
    expect(long.startsWith('init[0] failed (exit 1): ')).toBe(true);
    expect(formatFailureTail(long)).toBe(long);
  });

  it('keeps the start of a long one-line detail, where its cause is', () => {
    const detail = formatFailureTail(`Lock file is out of date: ${'x'.repeat(5_000)}`);
    const message = formatInitFailureMessage({ index: 0, exitCode: 1, detail });
    // fails-when: the head's budget is cut from the start of a one-line detail, dropping its cause
    expect(message.startsWith('init[0] failed (exit 1): Lock file is out of date: ')).toBe(true);
    expect(message.length).toBeLessThanOrEqual(FAILURE_TAIL_MAX_CHARS);
    expect(formatFailureTail(message)).toBe(message);
  });
});

describe('boundJobFailureData', () => {
  it('bounds the error and the init-failure message and keeps every other field', () => {
    const long = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n');
    const data = {
      error: long,
      dynamicFailed: true,
      initFailure: { scope: 'job', category: 'matrix_expansion', message: long, jobName: 'm' },
    };
    const out = boundJobFailureData(data);
    expect((out.error as string).split('\n')).toHaveLength(FAILURE_TAIL_MAX_LINES);
    expect((out.initFailure as { message: string }).message.split('\n')).toHaveLength(
      FAILURE_TAIL_MAX_LINES,
    );
    // breaks-if-wrong: the flags and the structured fields the orchestrator reads are untouched
    expect(out.dynamicFailed).toBe(true);
    expect((out.initFailure as { jobName: string }).jobName).toBe('m');
    expect(boundJobFailureData({ durationMs: 5 })).toEqual({ durationMs: 5 });
  });
});
