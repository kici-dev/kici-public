import {
  invalidRunIdMessage,
  parseRunIdRef,
  pickRunIdMatch,
  runIdHasPrefix,
} from '@kici-dev/engine';
import type { DashboardClient } from '../../remote/dashboard-client.js';

const FIND_HINT = "'kici runs list' shows full run ids";

/**
 * The full run id that `ref` (a run id, or its first characters like a git short SHA)
 * names, looked up in the run list, then in `localRunIds` (the local run history).
 */
export async function resolveRunRef(
  client: Pick<DashboardClient, 'listRuns'>,
  ref: string,
  localRunIds: readonly string[] = [],
): Promise<string> {
  const parsed = parseRunIdRef(ref);
  if (parsed.kind === 'uuid') return parsed.runId;
  if (parsed.kind === 'invalid')
    throw new Error(invalidRunIdMessage(ref, parsed.reason, FIND_HINT));
  const page = await client.listRuns({ runIdPrefix: parsed.hex, includeArchived: true });
  const ids = page.runs.map((r) => r.runId);
  let matches = ids.filter((id) => runIdHasPrefix(id, parsed.hex));
  // A Platform that ignored the filter returned other runs: a page of them proves nothing.
  if (matches.length < ids.length && page.hasMore) {
    throw new Error(
      `The Platform cannot look up the run id prefix '${ref}'; pass the full run id (${FIND_HINT}).`,
    );
  }
  if (matches.length === 0) {
    matches = [...new Set(localRunIds)].filter((id) => runIdHasPrefix(id, parsed.hex));
  }
  const unseen = page.hasMore ? Math.max(page.approxTotal - matches.length, 1) : 0;
  return pickRunIdMatch({ ref, matches, unseen, findHint: FIND_HINT });
}
