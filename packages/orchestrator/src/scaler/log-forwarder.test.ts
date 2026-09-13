import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { AgentLogForwarder, forwardLine } from './log-forwarder.js';
import type { LogCapture } from './types.js';

/** Collect all written data from a PassThrough stream as parsed JSON lines. */
function collectLines(stream: PassThrough): Record<string, unknown>[] {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Proxy([], {
    get(_, prop) {
      if (prop === 'length' || prop === Symbol.iterator || typeof prop === 'symbol') {
        const lines = Buffer.concat(chunks)
          .toString()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        if (prop === 'length') return lines.length;
        if (prop === Symbol.iterator) return lines[Symbol.iterator].bind(lines);
        return undefined;
      }
      const idx = Number(prop);
      if (!isNaN(idx)) {
        const lines = Buffer.concat(chunks)
          .toString()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        return lines[idx];
      }
      return undefined;
    },
  }) as unknown as Record<string, unknown>[];
}

/** Simple helper: parse output from a PassThrough into JSON lines */
function parseOutput(stream: PassThrough): Record<string, unknown>[] {
  const data = (stream.read() as Buffer | null) ?? Buffer.alloc(0);
  return data
    .toString()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Create a mock LogCapture that yields the given lines. */
function mockCapture(inputLines: string[]): LogCapture {
  return {
    lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < inputLines.length) {
                return { done: false as const, value: inputLines[i++] };
              }
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },
    tail() {
      return inputLines.join('\n');
    },
    close() {
      // no-op for mock
    },
  };
}

describe('forwardLine', () => {
  it('should parse, enrich, and write valid JSON input', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({ level: 'warn', message: 'disk full', timestamp: 12345 });

    forwardLine(jsonLine, 'agent-1', output);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      message: 'disk full',
      timestamp: 12345,
      service: 'agent',
      agentId: 'agent-1',
    });
  });

  it('should wrap non-JSON input as info-level message', () => {
    const output = new PassThrough();
    const plainLine = 'Starting agent bootstrap...';

    forwardLine(plainLine, 'agent-2', output);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'Starting agent bootstrap...',
      service: 'agent',
      agentId: 'agent-2',
    });
  });

  it('should merge context fields when provided', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({ level: 'info', message: 'step running' });

    forwardLine(jsonLine, 'agent-3', output, {
      runId: 'run-42',
      requestId: 'req-abc',
      jobId: 'job-7',
    });
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'step running',
      service: 'agent',
      agentId: 'agent-3',
      runId: 'run-42',
      requestId: 'req-abc',
      jobId: 'job-7',
    });
  });

  it('should preserve existing fields from agent JSON', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({
      level: 'error',
      message: 'compilation failed',
      timestamp: 999,
      error: 'SyntaxError',
      stack: 'at line 42',
      customField: 'custom-value',
    });

    forwardLine(jsonLine, 'agent-4', output);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      message: 'compilation failed',
      timestamp: 999,
      error: 'SyntaxError',
      stack: 'at line 42',
      customField: 'custom-value',
      service: 'agent',
      agentId: 'agent-4',
    });
  });

  it('should wrap JSON arrays and primitives as info-level messages', () => {
    const output = new PassThrough();

    forwardLine('[1,2,3]', 'agent-5', output);
    forwardLine('"just a string"', 'agent-5', output);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', message: '[1,2,3]', service: 'agent' });
    expect(lines[1]).toMatchObject({
      level: 'info',
      message: '"just a string"',
      service: 'agent',
    });
  });

  it('should include logsSource when provided', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({ level: 'info', message: 'from container' });

    forwardLine(jsonLine, 'agent-ls', output, undefined, 'podman');
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'from container',
      service: 'agent',
      agentId: 'agent-ls',
      logsSource: 'podman',
    });
  });

  it('should omit logsSource when not provided', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({ level: 'info', message: 'no source' });

    forwardLine(jsonLine, 'agent-ns', output);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('logsSource');
  });

  it('should omit context fields that are undefined', () => {
    const output = new PassThrough();
    const jsonLine = JSON.stringify({ level: 'info', message: 'test' });

    forwardLine(jsonLine, 'agent-6', output, { runId: 'run-1' });
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveProperty('runId', 'run-1');
    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[0]).not.toHaveProperty('jobId');
  });
});

describe('AgentLogForwarder', () => {
  it('should forward all lines from a LogCapture', async () => {
    const output = new PassThrough();
    const forwarder = new AgentLogForwarder('agent-fwd', output);

    const capture = mockCapture([
      JSON.stringify({ level: 'info', message: 'line 1' }),
      'plain text line 2',
      JSON.stringify({ level: 'error', message: 'line 3' }),
    ]);

    await forwarder.forward(capture);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'line 1',
      service: 'agent',
      agentId: 'agent-fwd',
    });
    expect(lines[1]).toMatchObject({
      level: 'info',
      message: 'plain text line 2',
      service: 'agent',
      agentId: 'agent-fwd',
    });
    expect(lines[2]).toMatchObject({
      level: 'error',
      message: 'line 3',
      service: 'agent',
      agentId: 'agent-fwd',
    });
  });

  it('should forward with context fields', async () => {
    const output = new PassThrough();
    const forwarder = new AgentLogForwarder('agent-ctx', output);

    const capture = mockCapture([JSON.stringify({ level: 'debug', message: 'traced' })]);

    await forwarder.forward(capture, { runId: 'run-99', jobId: 'job-55' });
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'debug',
      message: 'traced',
      service: 'agent',
      agentId: 'agent-ctx',
      runId: 'run-99',
      jobId: 'job-55',
    });
  });

  it('should pass logsSource through to all lines', async () => {
    const output = new PassThrough();
    const forwarder = new AgentLogForwarder('agent-src', output);

    const capture = mockCapture([
      JSON.stringify({ level: 'info', message: 'line 1' }),
      'plain text line 2',
    ]);

    await forwarder.forward(capture, undefined, 'docker');
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'line 1',
      logsSource: 'docker',
    });
    expect(lines[1]).toMatchObject({
      level: 'info',
      message: 'plain text line 2',
      logsSource: 'docker',
    });
  });

  it('should resolve when LogCapture yields no lines', async () => {
    const output = new PassThrough();
    const forwarder = new AgentLogForwarder('agent-empty', output);

    const capture = mockCapture([]);

    await forwarder.forward(capture);
    output.end();

    const lines = parseOutput(output);
    expect(lines).toHaveLength(0);
  });
});
