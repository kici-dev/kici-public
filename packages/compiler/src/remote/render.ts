/** Shared terminal-render helpers for the diagnostics + runs commands. */
import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';

export { formatDuration };

// ANSI SGR escape sequence (ESC [ ... m) used by picocolors. Matching the
// leading ESC keeps width calculations exact when colors are present.
const ANSI_SGR = /\[[0-9;]*m/g;

/** Length of a string ignoring ANSI color codes (for column alignment). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR, '');
}

/** Human "Ns/Nm/Nh/Nd ago" from an ISO timestamp; '—' when absent/invalid. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Color a run/job/step status. picocolors disables itself for NO_COLOR / non-TTY. */
export function colorStatus(status: string): string {
  if (!pc.isColorSupported) return status;
  switch (status) {
    case 'success':
      return pc.green(status);
    case 'failed':
    case 'error':
    case 'timed_out':
      return pc.red(status);
    case 'running':
      return pc.cyan(status);
    case 'cancelled':
      return pc.yellow(status);
    default:
      return pc.gray(status);
  }
}

/** Width-aligned ASCII table with a bold header row. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );
  const pad = (cell: string, i: number): string =>
    cell + ' '.repeat(Math.max(0, widths[i] - stripAnsi(cell).length));
  const header = headers.map((h, i) => pc.bold(pad(h, i))).join('  ');
  const body = rows.map((r) => r.map((c, i) => pad(c ?? '', i)).join('  ')).join('\n');
  return body ? `${header}\n${body}` : header;
}
