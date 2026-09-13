/**
 * Resolve the pull-request head context an `execution_runs` row records.
 *
 * `execution_runs.ref` is the branch a run PRESENTS — the BASE branch for a
 * pull request — so it says which branch a run targeted and nothing about where
 * the code came from. These three fields are the missing half, and the OIDC
 * mint reads them: without them a fork pull request and a trusted push to the
 * same base branch mint an identical identity.
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
 * `isFork` is resolved from the event TYPE, not from the presence of the
 * optional flag. A push, tag or schedule has no fork dimension, so `false` is
 * its true resolved value — not a stand-in. Leaving those unresolved would make
 * every `is_fork = 'false'` cloud trust policy reject legitimate pushes, and the
 * customer's fix for that (accepting `'unresolved'` too) would re-open the hole
 * the claim exists to close.
 *
 * NULL survives for exactly one case: a PR-family event whose payload carries
 * no head repository, so the fork question genuinely has no answer. A lost
 * write leaves all three NULL, which every claim renders as unresolved and a
 * policy that pins them therefore fails closed.
 *
 * The head repository is what decides that case, NOT the presence of the
 * `isForkPR` flag. Every normalizer derives that flag as `head !== base`, which
 * collapses to `false` when the payload names no head repository — a deleted
 * fork, or a trimmed payload. Reading the flag alone would therefore publish
 * `is_fork = 'false'` for a pull request nobody resolved, which is the fail-OPEN
 * direction this claim exists to remove.
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
