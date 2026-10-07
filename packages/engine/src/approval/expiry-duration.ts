import {
  MAX_APPROVAL_EXPIRY_SECONDS,
  MIN_APPROVAL_EXPIRY_SECONDS,
} from '../protocol/messages/platform-orchestrator.js';

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Parse an approval-expiry duration (`72h`, `30m`, `90s`, `1h30m`) into seconds.
 * Units appear at most once, in h-m-s order, with no spaces.
 *
 * Throws an `Error` for a malformed value and a `RangeError` for a value
 * outside `MIN_APPROVAL_EXPIRY_SECONDS..MAX_APPROVAL_EXPIRY_SECONDS`.
 */
export function parseExpiryDuration(input: string): number {
  const m = DURATION.exec(input);
  if (!input || !m) {
    throw new Error(`invalid duration "${input}": use h, m and s units, e.g. 72h or 1h30m`);
  }
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (seconds < MIN_APPROVAL_EXPIRY_SECONDS || seconds > MAX_APPROVAL_EXPIRY_SECONDS) {
    throw new RangeError(
      `duration "${input}" is outside ${MIN_APPROVAL_EXPIRY_SECONDS}s..${MAX_APPROVAL_EXPIRY_SECONDS}s`,
    );
  }
  return seconds;
}

/** Format seconds as the shortest exact h/m/s spelling, e.g. 5400 → `1h30m`. */
export function formatExpiryDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s || (!h && !m) ? `${s}s` : ''}`;
}
