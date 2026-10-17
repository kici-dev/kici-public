/** Most field paths an invalid-frame report lists. */
export const INVALID_FRAME_PATHS_MAX = 10;

/** A path segment safe to log and to send back: an index, or a short identifier. */
const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function renderSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') return String(segment);
  if (typeof segment === 'string' && SAFE_PATH_SEGMENT.test(segment)) return segment;
  return '*';
}

/**
 * The failing field paths of a validation failure, safe to log and to send back.
 *
 * A path names where a frame failed, never what it carried: a segment that is
 * not an array index or a short identifier (a record key the sender chose, for
 * instance) is written as `*`. A failure of the frame itself is `(frame)`.
 * Duplicates collapse, and at most {@link INVALID_FRAME_PATHS_MAX} are listed.
 */
export function invalidFramePaths(
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>,
): string[] {
  const paths = new Set<string>();
  for (const issue of issues) {
    paths.add(issue.path.length === 0 ? '(frame)' : issue.path.map(renderSegment).join('.'));
    if (paths.size === INVALID_FRAME_PATHS_MAX) break;
  }
  return [...paths];
}
