/**
 * A failed host command, described so an operator can act on it.
 *
 * Node's `execFile` rejects with `Command failed: <cmd>\n<stderr>`. That text
 * omits the exit code and the signal, and cannot tell a command that exited
 * non-zero from one the `timeout` option killed. A quiet tool (`mkfs.ext4 -q`)
 * that is killed prints nothing, so the message is only the command line.
 * `toCommandError` rebuilds the message from the error's own fields and keeps
 * them as properties for structured logs.
 *
 * Pure: the `execFile` call stays with each caller, which keeps its
 * `node:child_process` test seam.
 */
import { toErrorMessage } from '@kici-dev/core';

/**
 * Most stderr characters a {@link CommandError} keeps. A tool's own reason is
 * near the end of its output, so the tail is kept. The bound keeps the message
 * small enough for event details, database columns and log lines.
 */
export const COMMAND_STDERR_TAIL_CHARS = 2048;

/** Node's `execFile` code when a stream passes `maxBuffer`; that kill is not a timeout. */
const MAX_BUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** What a caller knows about the command, as opposed to what the error says. */
export interface CommandContext {
  /** The command line as run, including a `sudo -n` prefix. */
  command: string;
  /** The `timeout` passed to `execFile`, when one was. */
  timeoutMs?: number;
  /** Wall-clock time from the call until the rejection. */
  durationMs: number;
}

/** The fields a {@link CommandError} carries besides its message. */
export interface CommandFailure {
  command: string;
  /** Exit code, or `null` when the process did not exit on its own or never started. */
  exitCode: number | null;
  /** Signal that ended the process, or `null`. */
  signal: string | null;
  /** True when the `timeout` option killed the process. */
  timedOut: boolean;
  durationMs: number;
  /** Last {@link COMMAND_STDERR_TAIL_CHARS} characters of stderr, trimmed. */
  stderrTail: string;
}

/** A host command that failed, with its exit code, signal, timeout flag and stderr tail. */
export class CommandError extends Error implements CommandFailure {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stderrTail: string;

  constructor(message: string, failure: CommandFailure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CommandError';
    this.command = failure.command;
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.timedOut = failure.timedOut;
    this.durationMs = failure.durationMs;
    this.stderrTail = failure.stderrTail;
  }

  /**
   * The fields a log line can filter on. The stderr tail is left out: the
   * message already carries it.
   */
  toLogFields(): Omit<CommandFailure, 'stderrTail'> {
    return {
      command: this.command,
      exitCode: this.exitCode,
      signal: this.signal,
      timedOut: this.timedOut,
      durationMs: this.durationMs,
    };
  }
}

/** The last {@link COMMAND_STDERR_TAIL_CHARS} characters of `stderr`, trimmed, marked when cut. */
export function stderrTail(stderr: unknown): string {
  const text = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')).trim();
  if (text.length <= COMMAND_STDERR_TAIL_CHARS) return text;
  return `…${text.slice(text.length - COMMAND_STDERR_TAIL_CHARS)}`;
}

interface ExecErrorFields {
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
  stderr?: unknown;
}

/**
 * Convert an `execFile` rejection into a {@link CommandError}.
 *
 * Reads the fields Node sets on the error: `code` (the exit code, or an errno
 * string when the process never started), `signal`, `killed` and `stderr`.
 * A rejection without them, such as a plain `Error`, keeps its own message.
 */
export function toCommandError(err: unknown, ctx: CommandContext): CommandError {
  const fields: ExecErrorFields = typeof err === 'object' && err !== null ? err : {};
  const exitCode = typeof fields.code === 'number' ? fields.code : null;
  const errno = typeof fields.code === 'string' ? fields.code : null;
  const signal = typeof fields.signal === 'string' ? fields.signal : null;
  const timedOut = fields.killed === true && errno !== MAX_BUFFER_CODE;
  const tail = fields.stderr === undefined ? '' : stderrTail(fields.stderr);
  const ran = exitCode !== null || signal !== null;

  const cmd = `Command \`${ctx.command}\``;
  const after = `after ${ctx.durationMs} ms`;
  let reason: string;
  if (timedOut) {
    const limit = ctx.timeoutMs === undefined ? '' : ` (timeout ${ctx.timeoutMs} ms)`;
    reason = `${cmd} timed out: killed by ${signal ?? 'a signal'} ${after}${limit}`;
  } else if (signal !== null) {
    reason = `${cmd} was killed by ${signal} ${after}`;
  } else if (exitCode !== null) {
    reason = `${cmd} exited with code ${exitCode} ${after}`;
  } else if (errno !== null && errno !== MAX_BUFFER_CODE) {
    reason = `${cmd} could not start ${after}: ${toErrorMessage(err)}`;
  } else {
    // An exec error's own message repeats stderr, which is appended below once,
    // bounded. Any other error keeps its whole message.
    const message = toErrorMessage(err);
    reason = `${cmd} failed ${after}: ${fields.stderr === undefined ? message : firstLine(message)}`;
  }
  const stderrPart = tail ? `; stderr: ${tail}` : ran || timedOut ? '; stderr: (empty)' : '';

  return new CommandError(
    `${reason}${stderrPart}`,
    {
      command: ctx.command,
      exitCode,
      signal,
      timedOut,
      durationMs: ctx.durationMs,
      stderrTail: tail,
    },
    { cause: err },
  );
}

/** The text before the first newline. */
function firstLine(message: string): string {
  const nl = message.indexOf('\n');
  return nl === -1 ? message : message.slice(0, nl);
}
