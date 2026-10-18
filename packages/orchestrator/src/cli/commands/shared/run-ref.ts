/** Resolve a `kici-admin runs` run id: a full id, or a unique prefix (like a git short SHA). */
import {
  invalidRunIdMessage,
  parseRunIdRef,
  pickRunIdMatch,
  runIdHasPrefix,
} from '@kici-dev/engine';
import type { AdminApiClient } from '../../api-client.js';

const AMBIGUOUS_SHOWN = 5;
const FIND_HINT = "'kici-admin runs list' shows full run ids";

/** The full run id `ref` names; a prefix resolves through the run list. */
export async function resolveRunRef(client: AdminApiClient, ref: string): Promise<string> {
  const parsed = parseRunIdRef(ref);
  if (parsed.kind === 'uuid') return parsed.runId;
  if (parsed.kind === 'invalid')
    throw new Error(invalidRunIdMessage(ref, parsed.reason, FIND_HINT));
  const { runs, total } = await client.listRuns({
    runIdPrefix: parsed.hex,
    limit: AMBIGUOUS_SHOWN,
  });
  const ids = runs.map((r) => String(r.runId));
  const matches = ids.filter((id) => runIdHasPrefix(id, parsed.hex));
  // An older orchestrator ignores the filter: a page of other runs proves nothing.
  if (matches.length < ids.length && total > ids.length) throw new Error(prefixUnsupported(ref));
  return pickRunIdMatch({ ref, matches, unseen: total - ids.length, findHint: FIND_HINT });
}

function prefixUnsupported(ref: string): string {
  return `This orchestrator cannot look up the run id prefix '${ref}'; pass the full run id (${FIND_HINT}).`;
}
