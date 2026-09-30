/**
 * Download a URL into a file at network speed, resuming a cut transfer.
 *
 * The body goes to disk and nowhere else, so nothing slow sits between the
 * socket and the file: a consumer that holds the body back for minutes (tar
 * extraction of a large `node_modules`) keeps the connection open that long,
 * and an object store that closes it meanwhile fails the transfer.
 *
 * The client is `node:http` / `node:https`, not `fetch`. undici destroys a
 * response body with `TypeError: terminated` (cause `UND_ERR_SOCKET`, "other
 * side closed") when the server closes the keep-alive connection while the
 * body stream is paused with bytes still unparsed — even when every byte has
 * arrived. A file write stream pauses the body often enough to hit that on a
 * server that closes right after the response. `node:http` completes a
 * `Content-Length` body the server closed after, and it is the client the
 * agent's other object-storage transfers (`download.ts`) already use. The
 * default global agent honors `NODE_USE_ENV_PROXY` as `fetch` does, on
 * every Node.js release the packages support (24.5.0 and later).
 *
 * Resume: after a failed attempt, when the first response carried an `ETag`
 * and a `Content-Length`, the next attempt asks for the missing tail with
 * `Range: bytes=<on disk>-` and `If-Match: <etag>`. The tail is appended only
 * when the server answers `206` with a `Content-Range` that starts at exactly
 * the byte on disk and names the same total; a `200` rewrites the file from
 * zero with that same response, and any other answer restarts from zero on the
 * next attempt. So the file never splices bytes from two different objects.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createWriteStream } from 'node:fs';
import { rm, stat, truncate } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Per-attempt bounds and the retry budget of one download. */
export interface DownloadLimits {
  /** Attempts in total, the first included. */
  maxAttempts: number;
  /** Wall-clock bound on one attempt, from the request to the last byte. */
  attemptTimeoutMs: number;
  /** Socket inactivity bound inside an attempt. */
  stallTimeoutMs: number;
  /** Delay before the second attempt; doubles for each later one. */
  retryBaseDelayMs: number;
}

export const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = {
  maxAttempts: 3,
  attemptTimeoutMs: 5 * 60 * 1000,
  stallTimeoutMs: 60 * 1000,
  retryBaseDelayMs: 500,
};

/** Redirects followed per request, as `fetch` follows them. */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** An error reduced to the fields a log line needs, cause included. */
export interface DescribedError {
  message: string;
  code?: string;
  causeCode?: string;
  causeMessage?: string;
}

/** One attempt of a download, for the run log and the agent log. */
export interface DownloadAttempt {
  attempt: number;
  /** Byte offset the attempt asked for; 0 for a full download. */
  resumeFrom: number;
  /** HTTP status of the final response, when one arrived. */
  status?: number;
  /** Body bytes this attempt received. */
  bytesReceived: number;
  /** File size when the attempt ended. */
  bytesOnDisk: number;
  /** Full object size, from the first response's `Content-Length`. */
  expectedBytes?: number;
  durationMs: number;
  error?: DescribedError;
}

/** What the next attempt will do after a failed one. */
export interface NextAttempt {
  resumeFrom: number;
  delayMs: number;
}

export interface DownloadResult {
  bytes: number;
  attempts: DownloadAttempt[];
  durationMs: number;
}

/** A non-2xx answer (after redirects). */
export class DownloadHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'DownloadHttpError';
    this.status = status;
  }
}

/** Every attempt failed, or one failed in a way a retry cannot change. */
export class DownloadFailedError extends Error {
  readonly attempts: DownloadAttempt[];
  constructor(message: string, attempts: DownloadAttempt[], cause: unknown) {
    super(message, { cause });
    this.name = 'DownloadFailedError';
    this.attempts = attempts;
  }
}

/**
 * Whether a failed attempt is worth repeating. A transport error, a stall, a
 * timeout or a short body never reached a verdict; 5xx / 429 / 408 are the
 * overload and timeout answers; 412 / 416 mean the resume precondition failed
 * and the next attempt starts from zero. Every other status is a decision the
 * server will repeat — a 403 from an expired signature, a 404.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof DownloadHttpError)) return true;
  const s = err.status;
  return s >= 500 || s === 408 || s === 429 || s === 412 || s === 416;
}

/**
 * Milliseconds since `start` (a `performance.now()` reading), whole. The
 * monotonic clock keeps a duration from going negative when the wall clock
 * steps backwards, as an NTP correction on a fresh agent host can.
 */
export function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/** Drop the query (a presigned signature) and any userinfo from a URL for logging. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/** Reduce an error and its cause to loggable fields. */
export function describeError(err: unknown): DescribedError {
  if (!(err instanceof Error)) return { message: String(err) };
  const out: DescribedError = { message: err.message };
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === 'string') out.code = code;
  const cause = err.cause;
  if (cause instanceof Error) {
    out.causeMessage = cause.message;
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (typeof causeCode === 'string') out.causeCode = causeCode;
  }
  return out;
}

interface ContentRange {
  start: number;
  total: number | undefined;
}

function parseContentRange(value: string | undefined): ContentRange | undefined {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value ?? '');
  if (!m) return undefined;
  return { start: Number(m[1]), total: m[3] === '*' ? undefined : Number(m[3]) };
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** What identifies the object across attempts: resume needs both fields. */
interface Validator {
  etag: string | undefined;
  total: number | undefined;
}

/** Why an attempt was cut short on our side, named instead of the socket's `aborted`. */
interface AttemptCut {
  reason?: string;
}

function get(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  stallTimeoutMs: number,
  cut: AttemptCut,
  redirectsLeft = MAX_REDIRECTS,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers, signal }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(status) && location && redirectsLeft > 0) {
        res.resume();
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          // Thrown here it would escape this callback as an uncaught exception.
          reject(new Error(`HTTP ${status} redirect to an invalid Location`));
          return;
        }
        resolve(get(next, headers, signal, stallTimeoutMs, cut, redirectsLeft - 1));
        return;
      }
      resolve(res);
    });
    // Inactivity on the socket, not a deadline: it fires when nothing has been
    // read or written for the interval, including mid-body.
    req.setTimeout(stallTimeoutMs, () => {
      cut.reason = `stalled: no data for ${stallTimeoutMs} ms`;
      req.destroy(new Error(cut.reason));
    });
    req.on('error', reject);
  });
}

/** The resume offset for the next attempt, or 0 to start over. */
function resumeOffset(validator: Validator | undefined, onDisk: number): number {
  if (!validator?.etag || validator.total === undefined) return 0;
  return onDisk > 0 && onDisk < validator.total ? onDisk : 0;
}

/**
 * Download `url` into `dest`, retrying and resuming per {@link DownloadLimits}.
 * `dest` is overwritten. Rejects with {@link DownloadFailedError}.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: {
    limits?: Partial<DownloadLimits>;
    onAttemptFailed?: (attempt: DownloadAttempt, next: NextAttempt | undefined) => void;
  } = {},
): Promise<DownloadResult> {
  const limits = { ...DEFAULT_DOWNLOAD_LIMITS, ...opts.limits };
  const attempts: DownloadAttempt[] = [];
  const started = performance.now();
  let validator: Validator | undefined;
  await rm(dest, { force: true });

  for (let n = 1; n <= limits.maxAttempts; n++) {
    const onDisk = await sizeOf(dest);
    const resumeFrom = resumeOffset(validator, onDisk);
    if (resumeFrom === 0 && onDisk > 0) await truncate(dest, 0);

    const attemptStart = performance.now();
    const record: DownloadAttempt = {
      attempt: n,
      resumeFrom,
      bytesReceived: 0,
      bytesOnDisk: onDisk,
      durationMs: 0,
      ...(validator?.total !== undefined && { expectedBytes: validator.total }),
    };
    const cut: AttemptCut = {};
    const signal = AbortSignal.timeout(limits.attemptTimeoutMs);
    signal.addEventListener('abort', () => {
      cut.reason ??= `attempt timed out after ${limits.attemptTimeoutMs} ms`;
    });

    try {
      const headers: Record<string, string> =
        resumeFrom > 0 ? { range: `bytes=${resumeFrom}-`, 'if-match': validator!.etag! } : {};
      const res = await get(url, headers, signal, limits.stallTimeoutMs, cut);
      record.status = res.statusCode;
      let flags = 'w';
      if (res.statusCode === 206 && resumeFrom > 0) {
        const range = parseContentRange(res.headers['content-range']);
        if (!range || range.start !== resumeFrom || range.total !== validator!.total) {
          res.resume();
          validator = undefined;
          throw new Error(
            `resume refused: Content-Range "${res.headers['content-range'] ?? ''}" does not continue byte ${resumeFrom}`,
          );
        }
        flags = 'a';
      } else if (res.statusCode === 200) {
        const length = res.headers['content-length'];
        validator = {
          etag: res.headers.etag,
          total: length !== undefined ? Number(length) : undefined,
        };
        if (validator.total !== undefined) record.expectedBytes = validator.total;
      } else {
        res.resume();
        if (res.statusCode === 412 || res.statusCode === 416) validator = undefined;
        throw new DownloadHttpError(res.statusCode ?? 0);
      }

      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          record.bytesReceived += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(res, counter, createWriteStream(dest, { flags }));

      const size = await sizeOf(dest);
      if (validator?.total !== undefined && size !== validator.total) {
        throw new Error(`short body: ${size} of ${validator.total} bytes on disk`);
      }
      record.bytesOnDisk = size;
      record.durationMs = elapsedMs(attemptStart);
      attempts.push(record);
      return { bytes: size, attempts, durationMs: elapsedMs(started) };
    } catch (raw) {
      const err = cut.reason ? new Error(cut.reason, { cause: raw }) : raw;
      record.error = describeError(err);
      record.bytesOnDisk = await sizeOf(dest);
      record.durationMs = elapsedMs(attemptStart);
      attempts.push(record);

      const retry = isRetryable(err) && n < limits.maxAttempts;
      const next = retry
        ? {
            resumeFrom: resumeOffset(validator, record.bytesOnDisk),
            delayMs: limits.retryBaseDelayMs * 2 ** (n - 1),
          }
        : undefined;
      opts.onAttemptFailed?.(record, next);
      if (!next) {
        const tried = attempts.length === 1 ? '1 attempt' : `${attempts.length} attempts`;
        throw new DownloadFailedError(
          `Download failed after ${tried}: ${record.error.message}`,
          attempts,
          err,
        );
      }
      await new Promise((r) => setTimeout(r, next.delayMs));
    }
  }
  // The loop returns or throws on its last attempt.
  throw new DownloadFailedError('Download failed: no attempt ran', attempts, undefined);
}
