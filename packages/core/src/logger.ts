import winston from 'winston';
import pc from 'picocolors';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getRequestContext, type RequestContext } from './request-context.js';
import { toErrorMessage } from './error.js';

let _serviceName: string | undefined;

/** Request-context fields copied onto every log line the call site did not set. */
const TRACE_CONTEXT_FIELDS = [
  'requestId',
  'runId',
  'jobId',
  'routingKey',
  'traceId',
  'spanId',
] as const satisfies readonly (keyof RequestContext)[];

/**
 * Error codes raised when the reader of our stdout/stderr pipe goes away during
 * shutdown (e.g. the Windows Service Control Manager closing the inherited
 * stdout handle mid-write). They are swallowed, not raised as uncaught
 * exceptions; any other code is a real failure and is re-thrown.
 */
const SWALLOWED_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
]);

/** Guards against attaching the stdout/stderr error handlers more than once. */
let _streamErrorHandlersInstalled = false;

/**
 * Swallow {@link SWALLOWED_STREAM_ERROR_CODES} on stdout/stderr. Without it, a
 * Console-transport write racing the pipe close at shutdown raises EPIPE as an
 * uncaught exception, polluting error dashboards and perturbing the exit code a
 * service manager sees. Installed once at module load, never per logger, so no
 * MaxListenersExceededWarning.
 */
export function installStreamErrorHandlers(): void {
  if (_streamErrorHandlersInstalled) return;
  _streamErrorHandlersInstalled = true;

  const swallowPipeTeardown = (err: NodeJS.ErrnoException): void => {
    if (err.code && SWALLOWED_STREAM_ERROR_CODES.has(err.code)) return;
    // Not a pipe-teardown error — surface it instead of masking a real failure.
    throw err;
  };

  process.stdout.on('error', swallowPipeTeardown);
  process.stderr.on('error', swallowPipeTeardown);
}

installStreamErrorHandlers();

/**
 * Adds the service name and the request-context fields to a log line. A field
 * the call site set itself wins: a call site that names a run or job knows
 * which one the line is about, while the ambient request may be about another.
 * An explicit `null` stays; an `undefined` value counts as not set.
 */
const traceContextFormat = winston.format((info) => {
  if (_serviceName) info['service'] = _serviceName;
  const ctx = getRequestContext();
  for (const field of TRACE_CONTEXT_FIELDS) {
    const value = ctx[field];
    if (value && info[field] === undefined) info[field] = value;
  }
  return info;
});

/**
 * Loggers waiting for the service name before adding their rotated-file
 * transport. Module-level `createLogger()` calls run before `setServiceName()`;
 * an eager transport would write `kici-<instanceId>-*.log` instead of
 * `<service>-<instanceId>-*.log`.
 */
const _pendingFileTransportLoggers: Set<winston.Logger> = new Set();

/** Every rotated-file transport this process built, so {@link flushLogFiles} can reach them. */
const _fileTransports: Set<DailyRotateFile> = new Set();

/** The flush in progress, shared by every caller that arrives while it runs. */
let _flushInFlight: Promise<void> | null = null;

function buildFileTransport(): DailyRotateFile | undefined {
  // `process.env.KICI_LOG_DIR = undefined` stores the string "undefined"; treat
  // it as unset rather than create an `undefined/` directory.
  const dir = process.env.KICI_LOG_DIR;
  if (!dir || dir === 'undefined') return undefined;
  const transport = new DailyRotateFile({
    dirname: dir,
    filename: buildLogFilename(_serviceName),
    datePattern: 'YYYY-MM-DD',
    maxSize: process.env.KICI_LOG_MAX_SIZE ?? '500m',
    maxFiles: `${process.env.KICI_LOG_RETENTION_DAYS ?? '7'}d`,
    format: winston.format.combine(
      winston.format.timestamp(),
      traceContextFormat(),
      winston.format.json(),
    ),
    zippedArchive: true,
  });
  _fileTransports.add(transport);
  return transport;
}

/**
 * Write every logged line to the rotated log files, then stop writing to them.
 * Call it right before process.exit(): the file transport writes through an
 * async stream, so an exit that does not wait loses the last lines (stdout,
 * written synchronously, keeps them). Later lines reach the other transports
 * only. Concurrent callers share one flush. Resolves within `timeoutMs`.
 */
export function flushLogFiles(timeoutMs = 2_000): Promise<void> {
  if (_flushInFlight) return _flushInFlight;
  if (_fileTransports.size === 0) return Promise.resolve();
  _flushInFlight = closeFileTransports(timeoutMs).finally(() => {
    _flushInFlight = null;
  });
  return _flushInFlight;
}

async function closeFileTransports(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const flush = async (): Promise<void> => {
    // A line handed to a logger reaches its transports on a later turn of the event loop.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const transports = [..._fileTransports];
    _fileTransports.clear();
    await Promise.all(
      transports.map(
        (transport) =>
          new Promise<void>((resolve) => {
            transport.once('finish', () => resolve());
            transport.silent = true;
            transport.close?.();
          }),
      ),
    );
  };
  try {
    await Promise.race([flush(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Set the service name for all loggers in this process. Call once at startup. */
export function setServiceName(name: 'platform' | 'orchestrator' | 'agent'): void {
  _serviceName = name;
  for (const logger of _pendingFileTransportLoggers) {
    const transport = buildFileTransport();
    if (transport) logger.add(transport);
  }
  _pendingFileTransportLoggers.clear();
}

/** For testing and inspection. */
export function getServiceName(): string | undefined {
  return _serviceName;
}

/**
 * Rotated log filename. A stable instance ID, when set, is appended (sanitized
 * to filesystem-safe characters) so several processes can share one
 * KICI_LOG_DIR without racing on a file. Precedence: KICI_CLUSTER_INSTANCE_ID
 * (orchestrator) > KICI_AGENT_ID (agent) > KICI_PLATFORM_INSTANCE_ID (platform).
 */
export function buildLogFilename(serviceName: string | undefined): string {
  const base = serviceName ?? 'kici';
  const raw =
    process.env.KICI_CLUSTER_INSTANCE_ID ||
    process.env.KICI_AGENT_ID ||
    process.env.KICI_PLATFORM_INSTANCE_ID ||
    '';
  const suffix = raw.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return suffix ? `${base}-${suffix}-%DATE%.log` : `${base}-%DATE%.log`;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Minimal logger interface for dependency injection (avoids coupling to winston). */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface LoggerOptions {
  /**
   * Use JSON format (default: auto-detected from KICI_LOG_FORMAT env var, with
   * a TTY fallback). Passing an explicit boolean wins over the env var.
   */
  json?: boolean;
  /** Default: 'info'. */
  level?: LogLevel;
  /** Prefix for every message. */
  prefix?: string;
}

/**
 * Default for `json`: `KICI_LOG_FORMAT` (`json` / `plain` / `auto`); any other
 * value, unset included, falls back to TTY detection so a piped CLI still emits
 * JSON.
 */
function pickJsonDefault(): boolean {
  const envFormat = process.env.KICI_LOG_FORMAT;
  if (envFormat === 'json') return true;
  if (envFormat === 'plain') return false;
  return !process.stdout.isTTY;
}

export function createLogger(options: LoggerOptions = {}): winston.Logger {
  const { json = pickJsonDefault(), level = 'info', prefix } = options;

  // Masks kat_ agent tokens.
  const TOKEN_MASK_RE = /kat_[0-9a-f]{64}/gi;
  const maskTokens = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(TOKEN_MASK_RE, 'kat_***');
    }
    if (Array.isArray(value)) {
      return value.map(maskTokens);
    }
    if (value !== null && typeof value === 'object') {
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        masked[k] = maskTokens(v);
      }
      return masked;
    }
    return value;
  };
  const tokenMaskFormat = winston.format((info) => {
    if (typeof info.message === 'string') {
      info.message = info.message.replace(TOKEN_MASK_RE, 'kat_***');
    }
    for (const key of Object.keys(info)) {
      if (key === 'level' || key === 'message') continue;
      info[key] = maskTokens(info[key]);
    }
    return info;
  });

  // Info lines render as the bare message (call sites colour it themselves);
  // warn/error/debug get a coloured level prefix. No timestamp: the JSON
  // pipeline keeps it for Loki.
  const prettyFormat = winston.format.printf(({ level, message, requestId }) => {
    const traceStr =
      typeof requestId === 'string' ? `${pc.dim(`[${requestId.slice(0, 8)}]`)} ` : '';
    const prefixStr = prefix ? `${prefix} ` : '';

    if (level === 'info') {
      return `${traceStr}${prefixStr}${message}`;
    }

    let coloredLevel: string;
    switch (level) {
      case 'error':
        coloredLevel = pc.red(level);
        break;
      case 'warn':
        coloredLevel = pc.yellow(level);
        break;
      case 'debug':
        coloredLevel = pc.gray(level);
        break;
      default:
        coloredLevel = level;
    }
    return `${traceStr}${coloredLevel}: ${prefixStr}${message}`;
  });

  const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    traceContextFormat(),
    tokenMaskFormat(),
    winston.format.json(),
  );

  const prettyPipeline = winston.format.combine(
    traceContextFormat(),
    tokenMaskFormat(),
    prettyFormat,
  );

  // KICI_LOG_STDERR sends every level to stderr so a CLI's stdout data (e.g.
  // `kici-admin --json`) stays parseable; services leave it unset so the log
  // shipper reads stdout.
  const stderrTransport = Boolean(process.env.KICI_LOG_STDERR);
  const loggerInstance = winston.createLogger({
    level,
    format: json ? jsonFormat : prettyPipeline,
    transports: [
      new winston.transports.Console(
        stderrTransport
          ? { stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] }
          : {},
      ),
    ],
  });

  // KICI_LOG_DIR (bare-metal operators) adds file rotation, deferred until
  // setServiceName() when the service name is still unknown.
  if (process.env.KICI_LOG_DIR) {
    if (_serviceName) {
      const transport = buildFileTransport();
      if (transport) loggerInstance.add(transport);
    } else {
      _pendingFileTransportLoggers.add(loggerInstance);
    }
  }

  return loggerInstance;
}

/**
 * Default singleton logger. Its file transport stays deferred until
 * setServiceName() runs (CLI tools and scripts may never call it).
 */
export const logger = createLogger();

/**
 * Log a startup function's thrown error through the structured logger before
 * the process exits. Node's default handler prints a top-level `await`
 * rejection as multi-line text, which breaks log aggregators.
 */
export async function guardStartup(log: winston.Logger, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.error('Fatal startup error', {
      error: toErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}
