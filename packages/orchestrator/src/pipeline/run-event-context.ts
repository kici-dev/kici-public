/**
 * Resolve the pull-request head context an `execution_runs` row records.
 *
 * `execution_runs.ref` is the branch a run PRESENTS (the BASE branch for a pull
 * request), saying nothing about where the code came from. The OIDC mint reads
 * these fields: without them a fork pull request and a trusted push to the same
 * base branch mint an identical identity.
 */
import { isPullRequestFamilyTriggerEvent, type SimulatedEvent } from '@kici-dev/engine';

export interface RunEventContext {
  headRef: string | null;
  headRepository: string | null;
  isFork: boolean | null;
}

/**
 * Derive the head context from a normalized event.
 *
 * `isFork` follows the event TYPE, not the optional flag's presence: a push, tag
 * or schedule has no fork dimension, so `false` is its true value. Leaving it
 * unresolved would make every `is_fork = 'false'` cloud trust policy reject
 * legitimate pushes, and the customer's fix (also accepting `'unresolved'`)
 * would re-open the hole the claim closes.
 *
 * NULL survives only for a PR-family event whose payload has no head
 * repository. A lost write leaves all three NULL, which every claim renders as
 * unresolved, so a policy pinning them fails closed.
 *
 * The head repository decides that case, NOT the `isForkPR` flag: normalizers
 * derive it as `head !== base`, which collapses to `false` with no head
 * repository (a deleted fork, a trimmed payload), and would publish
 * `is_fork = 'false'` unresolved — the fail-OPEN direction.
 */
export function resolveRunEventContext(
  event: Pick<SimulatedEvent, 'type' | 'sourceBranch' | 'headRepo' | 'isForkPR'>,
): RunEventContext {
  const headRepository = event.headRepo ?? null;
  const isPrFamily = isPullRequestFamilyTriggerEvent(event.type);
  return {
    headRef: event.sourceBranch ?? null,
    headRepository,
    isFork: isPrFamily ? (headRepository === null ? null : (event.isForkPR ?? null)) : false,
  };
}
