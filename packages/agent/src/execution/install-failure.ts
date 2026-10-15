/**
 * Describe a failed package-manager install subprocess so the job error
 * carries what the package manager reported.
 *
 * `execFile` rejects with `Command failed: <cmd>` plus the child's stderr,
 * dropping the exit code, the signal, a timeout kill and all stdout; with empty
 * stderr it is the command line alone, so the job error holds no cause.
 * {@link describeInstallFailure} builds the message from the error's own fields.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toErrorMessage } from '@kici-dev/shared';
import { redactNpmOutput } from './npm-registry-config.js';

/** Kept per output stream. */
export const INSTALL_FAILURE_TAIL_LINES = 40;
/** Kept per output stream. */
export const INSTALL_FAILURE_TAIL_CHARS = 4000;

/** The fields `execFile` sets on the error it rejects with. */
interface ExecFileErrorFields {
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  /** The end of npm's debug log, attached by {@link attachNpmDebugLog}. */
  npmDebugLog?: unknown;
}

/** The end of `text`: at most the last lines and characters above. */
function tail(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  const joined = lines.slice(-INSTALL_FAILURE_TAIL_LINES).join('\n');
  const out = joined.slice(-INSTALL_FAILURE_TAIL_CHARS);
  const cut =
    lines.length > INSTALL_FAILURE_TAIL_LINES || joined.length > INSTALL_FAILURE_TAIL_CHARS;
  return cut ? `[…]\n${out}` : out;
}

function streamSection(name: string, value: unknown, tokens: readonly string[]): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (!text.trim()) return `${name}: (empty)`;
  return `${name}:\n${tail(redactNpmOutput(text, tokens))}`;
}

/**
 * Keeps the original error's first line (`Command failed: <cmd>`) and adds the
 * exit code or signal, whether the timeout killed the child, and the end of its
 * stderr and stdout, with every registry token in `tokens` redacted. An error
 * with no `stdout` / `stderr` fields (not a finished subprocess) keeps its own
 * message, redacted.
 */
export function describeInstallFailure(err: unknown, tokens: readonly string[]): string {
  const message = redactNpmOutput(toErrorMessage(err), tokens);
  if (!err || typeof err !== 'object' || !('stdout' in err || 'stderr' in err)) {
    return message;
  }
  const fields = err as ExecFileErrorFields;
  const headline = message.split('\n', 1)[0]!;
  const status: string[] = [];
  // A number is the child's exit status; a string is a Node error code for a
  // child that never ran or never finished (ENOENT, ABORT_ERR, a maxBuffer overflow).
  if (typeof fields.code === 'number') status.push(`exit code ${fields.code}`);
  else if (fields.code !== undefined && fields.code !== null)
    status.push(`error code ${String(fields.code)}`);
  if (fields.signal) status.push(`signal ${fields.signal}`);
  if (fields.killed === true) status.push('killed (timeout or abort)');
  return [
    headline,
    status.length ? status.join(', ') : 'exit code unknown',
    streamSection('stderr', fields.stderr, tokens),
    streamSection('stdout', fields.stdout, tokens),
    ...(typeof fields.npmDebugLog === 'string'
      ? [streamSection('npm debug log', fields.npmDebugLog, tokens)]
      : []),
  ].join('\n');
}

/**
 * Attach npm's newest debug log under `cacheDir` to a failed npm install's
 * error, for {@link describeInstallFailure}.
 *
 * npm writes a debug log per run to `<cache>/_logs/`, and it holds the cause
 * even when stderr is empty. The per-job cache directory is removed after the
 * install, so read the log before that cleanup. An unreadable log leaves the
 * error unchanged.
 */
export async function attachNpmDebugLog(err: unknown, cacheDir: string): Promise<void> {
  if (!err || typeof err !== 'object') return;
  try {
    const logsDir = join(cacheDir, '_logs');
    const newest = (await readdir(logsDir))
      .filter((n) => n.endsWith('.log'))
      .sort()
      .at(-1);
    if (!newest) return;
    (err as ExecFileErrorFields).npmDebugLog = await readFile(join(logsDir, newest), 'utf-8');
  } catch {
    // No debug log: npm did not start, or wrote it elsewhere.
  }
}
