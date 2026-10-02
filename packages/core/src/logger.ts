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
 * Node error codes that are expected when the process that consumes our
 * stdout/stderr pipe goes away during shutdown (e.g. the Windows Service
 * Control Manager closing the inherited stdout handle while a `console.log`
 * write is still in flight). These are not real failures — they only happen
 * when the consuming pipe is already gone — so we swallow them rather than let
 * them surface as an uncaught exception at error level. Any other error code
 * is a genuine stdout/stderr failure and is re-thrown.
 */
const SWALLOWED_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
]);

/** Guards against attaching the stdout/stderr error handlers more than once. */
let _streamErrorHandlersInstalled = false;

/**
 * Install a once-only 'error' listener on `process.stdout` and
 * `process.stderr` that swallows the pipe-teardown errors in
 * {@link SWALLOWED_STREAM_ERROR_CODES} and re-throws anything else.
 *
 * Without this, an in-flight synchronous write to stdout/stderr (winston's
 * Console transport) racing the pipe closing at shutdown propagates EPIPE as an
 * uncaught exception — which pollutes error dashboards and can perturb the
 * process exit code a service manager observes. The handler is installed once
 * at module load; `createLogger()` does not attach per-instance listeners, so
 * no listener leak / MaxListenersExceededWarning can occur.
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
 * Tracked set of loggers still waiting for the service name so they can
 * add their rotated-file transport with the right filename. Module-level
 * `createLogger()` calls resolve before the service's `setServiceName()`
 * runs; if we built the file transport eagerly, every such logger would
 * write to `kici-<instanceId>-*.log` (undefined service name) instead of
 * `<service>-<instanceId>-*.log`. Holding them here lets setServiceName
 * attach the correct transport once, in one place.
 */
const _pendingFileTransportLoggers: Set<winston.Logger> = new Set();

/** Every rotated-file transport this process built, so {@link flushLogFiles} can reach them. */
const _fileTransports: Set<DailyRotateFile> = new Set();

/** The flush in progress, shared by every caller that arrives while it runs. */
let _flushInFlight: Promise<void> | null = null;

function buildFileTransport(): DailyRotateFile | undefined {
  // Defensive: `process.env.KICI_LOG_DIR = undefined` coerces to the literal
  // string "undefined", which would create an `undefined/` directory at the
  // cwd. Treat that as unset to match operator intent.
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
 * Write every line already logged to the rotated log files, then stop writing
 * to them. A shutdown calls it right before process.exit(): the file transport
 * writes through an asynchronous stream, and an exit that does not wait for it
 * loses the last lines, which stdout (written synchronously) still has. Lines
 * logged after the flush reach the other transports only. A caller that
 * arrives while a flush runs waits for that flush. Resolves within
 * `timeoutMs`.
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
  // Now that the service name is known, attach the file-rotation transport
  // to every logger that opted in while the name was still undefined.
  for (const logger of _pendingFileTransportLoggers) {
    const transport = buildFileTransport();
    if (transport) logger.add(transport);
  }
  _pendingFileTransportLoggers.clear();
}

/** Get the current service name (for testing/inspection). */
export function getServiceName(): string | undefined {
  return _serviceName;
}

/**
 * Build the rotated log filename. When a stable instance ID is available in the
 * environment, append it so multiple processes (e.g. several orchestrators or
 * agents) can safely share one KICI_LOG_DIR without racing on the same file.
 *
 * Precedence matches the tier that owns each variable:
 * orchestrator (KICI_CLUSTER_INSTANCE_ID) > agent (KICI_AGENT_ID) > platform
 * (KICI_PLATFORM_INSTANCE_ID). Sanitize defensively to filesystem-safe characters.
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

/** Log level type */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Minimal logger interface for dependency injection (avoids coupling to winston). */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Logger creation options */
interface LoggerOptions {
  /**
   * Use JSON format (default: auto-detected from KICI_LOG_FORMAT env var, with
   * a TTY fallback). Passing an explicit boolean wins over the env var.
   */
  json?: boolean;
  /** Log level (default: 'info') */
  level?: LogLevel;
  /** Optional prefix for all messages */
  prefix?: string;
}

/**
 * Pick the default JSON-vs-plain selection for `createLogger` callers that do
 * not pass an explicit `json` option. Honours the operator-controlled
 * `KICI_LOG_FORMAT` env var (`json` / `plain` / `auto`); anything else
 * (including typos and unset) falls back to TTY detection so a piped CLI
 * still produces machine-readable JSON.
 */
function pickJsonDefault(): boolean {
  const envFormat = process.env.KICI_LOG_FORMAT;
  if (envFormat === 'json') return true;
  if (envFormat === 'plain') return false;
  return !process.stdout.isTTY;
}

/**
 * Create a winston logger instance.
 *
 * @param options - Logger configuration options
 * @returns Configured winston logger
 */
export function createLogger(options: LoggerOptions = {}): winston.Logger {
  const { json = pickJsonDefault(), level = 'info', prefix } = options;

  // Token masking format: replaces kat_ agent tokens in log output
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
    // Mask token values in metadata fields
    for (const key of Object.keys(info)) {
      if (key === 'level' || key === 'message') continue;
      info[key] = maskTokens(info[key]);
    }
    return info;
  });

  // Pretty format for CLI / TTY use. Info lines render as just the message
  // (the call site already provides colour where it wants it); warn/error/debug
  // get a coloured level prefix so abnormal output stands out. No timestamp —
  // humans don't need it, and JSON pipeline retains structured timestamps for
  // Loki ingestion.
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

  // JSON format for backend services: timestamp -> trace context -> mask tokens -> json
  const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    traceContextFormat(),
    tokenMaskFormat(),
    winston.format.json(),
  );

  // Pretty format pipeline: trace context -> mask tokens -> pretty printer.
  // No timestamp stage — the plain printer intentionally drops it for human
  // readability.
  const prettyPipeline = winston.format.combine(
    traceContextFormat(),
    tokenMaskFormat(),
    prettyFormat,
  );

  // When KICI_LOG_STDERR is set, route every log level to stderr instead of
  // stdout. Short-lived CLIs (kici-admin) emit structured data on stdout (e.g.
  // `--json` output); keeping diagnostic logs off stdout keeps that data
  // machine-parseable. Long-running services leave this unset so their logs
  // stay on stdout for the log shipper. `stderrLevels` covering every npm level
  // sends all output to stderr.
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

  // Add file rotation transport when KICI_LOG_DIR is set (for bare-metal operators).
  // If the service name hasn't been decided yet, defer attachment until
  // setServiceName() is called so the filename carries the right prefix.
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
 * Default singleton logger instance for simple use cases. If KICI_LOG_DIR is
 * set but setServiceName() hasn't been called yet (CLI tools, scripts),
 * the file transport stays deferred and is attached only once a service
 * name is known — protecting against writing to `kici-<instanceId>-*.log`.
 */
export const logger = createLogger();

/**
 * Wrap an async startup function so that any thrown error is logged
 * through the structured (JSON-aware) logger before the process exits.
 *
 * Without this guard, a top-level `await` rejection in an ESM entry
 * point is printed by Node.js's default handler (multi-line, not JSON),
 * which breaks log aggregators like ELK.
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
