import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Writable } from 'node:stream';
import winston from 'winston';
import {
  setServiceName,
  getServiceName,
  createLogger,
  buildLogFilename,
  installStreamErrorHandlers,
} from './logger.js';
import { requestContext } from './request-context.js';

/**
 * Strip ANSI colour codes so plain-text assertions can match against the
 * coloured printf output regardless of the picocolors TTY-detection result.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/**
 * Build a plain-format logger that writes lines to an in-memory buffer.
 * Mirrors `createCaptureLogger` but exercises the pretty pipeline so we can
 * assert on the rendered string instead of JSON.
 */
function createPlainCaptureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString().trimEnd());
      callback();
    },
  });

  const logger = createLogger({ json: false });
  logger.clear();
  logger.add(new winston.transports.Stream({ stream }));

  return {
    logger,
    getLines: () => lines.slice(),
    getLastLine: () => lines[lines.length - 1],
  };
}

/**
 * Helper: create a JSON logger that writes to a captured string buffer.
 * The logger uses createLogger({ json: true }) so the format pipeline
 * (timestamp -> traceContextFormat -> json) is preserved. We only swap
 * the Console transport for a Stream transport WITHOUT a custom format,
 * so the logger-level format runs and we capture the final JSON output.
 */
function createCaptureLogger() {
  const lines: string[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString().trimEnd());
      callback();
    },
  });

  const logger = createLogger({ json: true });

  // Replace the default Console transport with a Stream transport (no format override)
  logger.clear();
  logger.add(new winston.transports.Stream({ stream }));

  return {
    logger,
    getLastLine: () => {
      const last = lines[lines.length - 1];
      return last ? (JSON.parse(last) as Record<string, unknown>) : undefined;
    },
  };
}

describe('setServiceName / getServiceName', () => {
  beforeEach(() => {
    // Reset _serviceName to undefined between tests.
    // Cast to bypass the type union for reset purposes.
    (setServiceName as (name: string | undefined) => void)(undefined as unknown as string);
  });

  it('stores and retrieves the service name', () => {
    expect(getServiceName()).toBeUndefined();
    setServiceName('orchestrator');
    expect(getServiceName()).toBe('orchestrator');
  });

  it('overrides a previous value', () => {
    setServiceName('platform');
    expect(getServiceName()).toBe('platform');
    setServiceName('orchestrator');
    expect(getServiceName()).toBe('orchestrator');
  });

  it('returns undefined when not set', () => {
    expect(getServiceName()).toBeUndefined();
  });
});

describe('service field in JSON log output', () => {
  beforeEach(() => {
    (setServiceName as (name: string | undefined) => void)(undefined as unknown as string);
  });

  it('includes service field when setServiceName was called', async () => {
    setServiceName('platform');

    const { logger, getLastLine } = createCaptureLogger();
    logger.info('test message');

    // Winston stream transport is synchronous in practice but give it a tick
    await new Promise((r) => setTimeout(r, 50));

    const output = getLastLine();
    expect(output).toBeDefined();
    expect(output!.service).toBe('platform');
    expect(output!.message).toBe('test message');
  });

  it('omits service field when setServiceName was not called', async () => {
    const { logger, getLastLine } = createCaptureLogger();
    logger.info('no service');

    await new Promise((r) => setTimeout(r, 50));

    const output = getLastLine();
    expect(output).toBeDefined();
    expect(output!.service).toBeUndefined();
  });
});

describe('traceId/spanId enrichment', () => {
  beforeEach(() => {
    (setServiceName as (name: string | undefined) => void)(undefined as unknown as string);
  });

  it('includes traceId and spanId when present in request context', async () => {
    const { logger, getLastLine } = createCaptureLogger();

    await requestContext.run(
      {
        requestId: 'req-123',
        traceId: 'abc123trace',
        spanId: 'def456span',
      },
      async () => {
        logger.info('with trace');
        await new Promise((r) => setTimeout(r, 50));
      },
    );

    const output = getLastLine();
    expect(output).toBeDefined();
    expect(output!.traceId).toBe('abc123trace');
    expect(output!.spanId).toBe('def456span');
  });

  it('omits traceId and spanId when not in request context', async () => {
    const { logger, getLastLine } = createCaptureLogger();
    logger.info('no trace');

    await new Promise((r) => setTimeout(r, 50));

    const output = getLastLine();
    expect(output).toBeDefined();
    expect(output!.traceId).toBeUndefined();
    expect(output!.spanId).toBeUndefined();
  });
});

describe('file rotation transport', () => {
  it('adds file rotation transport when KICI_LOG_DIR is set', () => {
    const origLogDir = process.env.KICI_LOG_DIR;
    try {
      process.env.KICI_LOG_DIR = '/tmp/test-logs';
      setServiceName('platform');

      const logger = createLogger({ json: true });

      // Should have 2 transports: Console + DailyRotateFile
      expect(logger.transports.length).toBe(2);
      const rotateTransport = logger.transports[1];
      expect(rotateTransport).toBeDefined();
    } finally {
      // `process.env.X = undefined` stringifies to the literal "undefined" and
      // creates spurious `undefined/`-prefixed paths the next time a logger
      // reads it. Delete instead of assigning when the original was unset.
      if (origLogDir === undefined) delete process.env.KICI_LOG_DIR;
      else process.env.KICI_LOG_DIR = origLogDir;
    }
  });

  it('does not add file rotation transport when KICI_LOG_DIR is not set', () => {
    const origLogDir = process.env.KICI_LOG_DIR;
    try {
      delete process.env.KICI_LOG_DIR;

      const logger = createLogger({ json: true });

      // Should have only 1 transport: Console
      expect(logger.transports.length).toBe(1);
    } finally {
      if (origLogDir !== undefined) {
        process.env.KICI_LOG_DIR = origLogDir;
      }
    }
  });

  it('defers file transport when KICI_LOG_DIR is set but service name is not', () => {
    const origLogDir = process.env.KICI_LOG_DIR;
    try {
      process.env.KICI_LOG_DIR = '/tmp/test-logs';
      (setServiceName as (name: string | undefined) => void)(undefined as unknown as string);

      const logger = createLogger({ json: true });

      // Console only — file transport deferred
      expect(logger.transports.length).toBe(1);

      // Once the service name resolves, the file transport is attached.
      setServiceName('orchestrator');
      expect(logger.transports.length).toBe(2);
    } finally {
      if (origLogDir === undefined) delete process.env.KICI_LOG_DIR;
      else process.env.KICI_LOG_DIR = origLogDir;
    }
  });
});

describe('buildLogFilename', () => {
  const envKeys = [
    'KICI_CLUSTER_INSTANCE_ID',
    'KICI_AGENT_ID',
    'KICI_PLATFORM_INSTANCE_ID',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterAll(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('omits the suffix when no instance env var is set', () => {
    expect(buildLogFilename('orchestrator')).toBe('orchestrator-%DATE%.log');
  });

  it('uses KICI_CLUSTER_INSTANCE_ID for the orchestrator tier', () => {
    process.env.KICI_CLUSTER_INSTANCE_ID = 'host-1-stg';
    expect(buildLogFilename('orchestrator')).toBe('orchestrator-host-1-stg-%DATE%.log');
  });

  it('uses KICI_AGENT_ID for the agent tier', () => {
    process.env.KICI_AGENT_ID = 'stg-stateful-agent';
    expect(buildLogFilename('agent')).toBe('agent-stg-stateful-agent-%DATE%.log');
  });

  it('uses KICI_PLATFORM_INSTANCE_ID for the platform tier', () => {
    process.env.KICI_PLATFORM_INSTANCE_ID = 'platform-1';
    expect(buildLogFilename('platform')).toBe('platform-platform-1-%DATE%.log');
  });

  it('prefers KICI_CLUSTER_INSTANCE_ID when multiple env vars are set', () => {
    process.env.KICI_CLUSTER_INSTANCE_ID = 'orch-a';
    process.env.KICI_AGENT_ID = 'agent-a';
    process.env.KICI_PLATFORM_INSTANCE_ID = 'plat-a';
    expect(buildLogFilename('orchestrator')).toBe('orchestrator-orch-a-%DATE%.log');
  });

  it('falls back to "kici" when the service name is undefined', () => {
    process.env.KICI_CLUSTER_INSTANCE_ID = 'host-1-stg';
    expect(buildLogFilename(undefined)).toBe('kici-host-1-stg-%DATE%.log');
  });

  it('sanitizes unsafe characters in the instance id', () => {
    process.env.KICI_CLUSTER_INSTANCE_ID = 'weird/id with spaces';
    expect(buildLogFilename('orchestrator')).toBe('orchestrator-weird_id_with_spaces-%DATE%.log');
  });
});

describe('stdout/stderr pipe-teardown error handling', () => {
  it('installs an error listener on process.stdout and process.stderr at module load', () => {
    // The module already called installStreamErrorHandlers() at import time, so
    // both real streams carry a swallowing listener.
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0);
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
  });

  it('is idempotent — a second install adds no extra listeners', () => {
    const before = process.stdout.listenerCount('error');
    installStreamErrorHandlers();
    expect(process.stdout.listenerCount('error')).toBe(before);
  });

  it('swallows an EPIPE error emitted on process.stdout (no uncaught exception)', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // If the handler did not swallow it, emit() would re-throw the error.
    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
  });

  it('swallows an ERR_STREAM_DESTROYED error emitted on process.stderr', () => {
    const destroyed = Object.assign(new Error('stream destroyed'), {
      code: 'ERR_STREAM_DESTROYED',
    });
    expect(() => process.stderr.emit('error', destroyed)).not.toThrow();
  });

  it('does NOT swallow a non-pipe-teardown error (re-throws it)', () => {
    const other = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    expect(() => process.stdout.emit('error', other)).toThrow(/disk full/);
  });
});

describe('KICI_LOG_FORMAT format selection', () => {
  const savedFormat = process.env.KICI_LOG_FORMAT;
  const savedIsTTY = process.stdout.isTTY;

  afterEach(() => {
    if (savedFormat === undefined) delete process.env.KICI_LOG_FORMAT;
    else process.env.KICI_LOG_FORMAT = savedFormat;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: savedIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it('plain mode renders info as just the message (no timestamp, no level prefix)', async () => {
    process.env.KICI_LOG_FORMAT = 'plain';
    const { logger, getLastLine } = createPlainCaptureLogger();
    logger.info('Initializing kici...');
    await new Promise((r) => setTimeout(r, 50));

    const line = stripAnsi(getLastLine() ?? '');
    expect(line).toBe('Initializing kici...');
    expect(line).not.toMatch(/info:/);
    expect(line).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('plain mode renders warn with a coloured level prefix and no timestamp', async () => {
    process.env.KICI_LOG_FORMAT = 'plain';
    const { logger, getLastLine } = createPlainCaptureLogger();
    logger.warn('Workflow file missing');
    await new Promise((r) => setTimeout(r, 50));

    const raw = getLastLine() ?? '';
    const line = stripAnsi(raw);
    expect(line).toBe('warn: Workflow file missing');
    expect(line).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('KICI_LOG_FORMAT=json forces JSON regardless of TTY', async () => {
    process.env.KICI_LOG_FORMAT = 'json';
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString().trimEnd());
        callback();
      },
    });
    const logger = createLogger();
    logger.clear();
    logger.add(new winston.transports.Stream({ stream }));
    logger.info('json payload');
    await new Promise((r) => setTimeout(r, 50));

    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('json payload');
  });

  it('unset KICI_LOG_FORMAT + non-TTY stdout falls back to JSON', async () => {
    delete process.env.KICI_LOG_FORMAT;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString().trimEnd());
        callback();
      },
    });
    const logger = createLogger();
    logger.clear();
    logger.add(new winston.transports.Stream({ stream }));
    logger.info('piped');
    await new Promise((r) => setTimeout(r, 50));

    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    // Auto mode + non-TTY → JSON.
    expect(() => JSON.parse(last!)).not.toThrow();
    const parsed = JSON.parse(last!) as Record<string, unknown>;
    expect(parsed.message).toBe('piped');
  });

  it('unset KICI_LOG_FORMAT + TTY stdout falls back to plain', async () => {
    delete process.env.KICI_LOG_FORMAT;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString().trimEnd());
        callback();
      },
    });
    const logger = createLogger();
    logger.clear();
    logger.add(new winston.transports.Stream({ stream }));
    logger.info('on a TTY');
    await new Promise((r) => setTimeout(r, 50));

    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    // Auto mode + TTY → plain. Not JSON-parseable, no level prefix on info.
    expect(() => JSON.parse(last!)).toThrow();
    expect(stripAnsi(last!)).toBe('on a TTY');
  });

  it('explicit createLogger({ json: true }) wins over KICI_LOG_FORMAT=plain', async () => {
    process.env.KICI_LOG_FORMAT = 'plain';
    const { logger, getLastLine } = createCaptureLogger();
    logger.info('explicit wins');
    await new Promise((r) => setTimeout(r, 50));
    const out = getLastLine();
    expect(out).toBeDefined();
    expect(out!.message).toBe('explicit wins');
  });
});
