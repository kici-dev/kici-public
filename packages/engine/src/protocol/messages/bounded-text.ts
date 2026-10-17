import { z } from 'zod';

/** Appended to a string cut at its end, so a reader knows text is missing. */
export const TRUNCATION_MARKER = '… (truncated)';

/** Prepended to a string cut at its start: the end of the text is what was kept. */
export const KEEP_END_TRUNCATION_MARKER = '… (truncated) ';

/**
 * Truncate `text` to at most `max` UTF-16 code units, keeping its start and
 * marking that it was cut.
 *
 * - A `max` no larger than the marker returns the truncated marker, never a
 *   string longer than `max`.
 * - The cut backs off one unit rather than split a surrogate pair.
 */
export function truncateReasonText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, max);
  let cut = max - TRUNCATION_MARKER.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + TRUNCATION_MARKER;
}

/**
 * Truncate `text` to at most `max` UTF-16 code units, keeping its END and
 * marking at the start that text was cut. For output whose cause is at the
 * bottom, such as a failed command's error stream.
 *
 * The same edges as {@link truncateReasonText}: a `max` too small for the
 * marker returns the cut marker, and a cut that lands on the low half of a
 * surrogate pair moves forward by one unit.
 */
export function truncateReasonTextKeepEnd(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= KEEP_END_TRUNCATION_MARKER.length) return KEEP_END_TRUNCATION_MARKER.slice(0, max);
  let start = text.length - (max - KEEP_END_TRUNCATION_MARKER.length);
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return KEEP_END_TRUNCATION_MARKER + text.slice(start);
}

/**
 * A free-text wire field bounded by clamping instead of refusal.
 *
 * A failure message or commit message can be longer than the bound for
 * reasons no sender controls (a tool's progress output, a long commit
 * subject). Refusing it would make the whole message invalid; clamping keeps
 * the message and marks the cut. Identifier fields keep a strict `max()`.
 */
export function boundedFreeText(max: number) {
  return z.string().transform((text) => truncateReasonText(text, max));
}
