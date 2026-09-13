import { describe, expect, it } from 'vitest';
import { unwrapStoredLogLine } from './streaming.js';

describe('unwrapStoredLogLine', () => {
  it('returns the msg of a stored log envelope', () => {
    // fails-when: the poll loop prints relayed lines verbatim, so a developer
    // watching `kici run remote` reads {"ts":…,"level":"stdout","msg":…} for
    // every line the job printed — the shape that shipped until this test.
    const line =
      '{"ts":"2026-09-12T09:30:49.325Z","level":"stdout","msg":"✔ the committed test passes","meta":{}}';
    expect(unwrapStoredLogLine(line)).toBe('✔ the committed test passes');
  });

  it('unwraps a stderr envelope the same way', () => {
    expect(
      unwrapStoredLogLine(
        '{"ts":"2026-09-12T09:30:49.349Z","level":"stderr","msg":"npm notice","meta":{}}',
      ),
    ).toBe('npm notice');
  });

  it('passes a plain line through unchanged', () => {
    // breaks-if-wrong: an orchestrator phase marker or a line from an older
    // store is not an envelope and must still reach the terminal as itself.
    expect(unwrapStoredLogLine('Run started: abc')).toBe('Run started: abc');
    expect(unwrapStoredLogLine('')).toBe('');
  });

  it('passes JSON that is not an envelope through unchanged', () => {
    // A job that prints its own JSON (a `{"result":"ok"}` line) must not be
    // rewritten: only an object with a string `msg` is the store's envelope.
    expect(unwrapStoredLogLine('{"result":"ok"}')).toBe('{"result":"ok"}');
    expect(unwrapStoredLogLine('{"msg":42}')).toBe('{"msg":42}');
    expect(unwrapStoredLogLine('{not json')).toBe('{not json');
  });
});
