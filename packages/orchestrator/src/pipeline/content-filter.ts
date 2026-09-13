/**
 * Tier-1 declarative content-requirements filter (execution-purity model, Part B).
 *
 * After Tier-0 trigger matching selects candidate workflows, this step fetches
 * the source files each candidate's `requires` names — once per distinct
 * `(repo, sha, path)` via the LRU cache — evaluates the (pure DATA) requirements
 * with the engine matcher, and drops any candidate that FAILS or is
 * INDETERMINATE before dispatch. No author code is executed: `requires` is a
 * declarative query the orchestrator interprets, which is what keeps content
 * filtering inside the orchestrator under the purity model.
 *
 * Fail-visible: a dropped candidate (definite negative, oversize/unparseable
 * content, a fetch error, or no fetcher/cache available) is logged with the
 * concrete reason. An indeterminate file NEVER passes silently.
 */

import type { FileContentsFetcher, LockContentRequirement } from '@kici-dev/engine';
import { evaluateContentRequirements } from '@kici-dev/engine/trigger/content-requirements';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ContentRequirementsCache, FileContentEntry } from '../content-requirements-cache.js';

const logger = createLogger({ prefix: 'content-filter' });

/** A workflow candidate carrying the `requires` of the trigger that matched the event. */
export interface ContentFilterCandidate {
  readonly name: string;
  readonly requires?: readonly LockContentRequirement[];
}

/** The event the requirements are evaluated against: source repo + ref to fetch files at. */
export interface ContentFilterEvent {
  /** Provider repo identifier ("owner/repo"). */
  readonly repo: string;
  /** Git ref (commit SHA, or branch/tag) at which files are read. */
  readonly sha: string;
}

export interface ContentFilterOptions {
  /** Per-delivery file-contents fetcher; `undefined` when the provider has none. */
  readonly fetcher: FileContentsFetcher | undefined;
  /** Shared LRU cache; `undefined` when the deployment did not wire one. */
  readonly cache: ContentRequirementsCache | undefined;
  /** Delivery id for log correlation. */
  readonly deliveryId?: string;
}

/**
 * One dropped candidate.
 *
 * `indeterminate` separates the two reasons a drop happens, which mean opposite
 * things to a workflow author: a definite content mismatch is the requirement
 * doing its job, while an unreadable file, a fetch error, or a provider with no
 * file-contents fetcher is the requirement never having been evaluated at all.
 * Both drop the candidate — the filter is fail-visible, so an unevaluable file
 * never passes — but a trace that renders the second as "excluded" tells an
 * author their requirement said no when nothing ever read it.
 */
export interface DroppedCandidate {
  readonly name: string;
  readonly reason: string;
  /** True when the requirement could not be evaluated, rather than evaluating to false. */
  readonly indeterminate?: boolean;
}

export interface ContentFilterResult<C extends ContentFilterCandidate> {
  readonly survivors: C[];
  readonly dropped: DroppedCandidate[];
}

/** True when a requirement queries the file bytes (as opposed to a bare existence / `absent` check). */
function requirementNeedsBytes(req: LockContentRequirement): boolean {
  if (req.absent) return false;
  return (
    (req.matches !== undefined && req.matches.length > 0) ||
    (req.notMatches !== undefined && req.notMatches.length > 0) ||
    (req.contains !== undefined && req.contains.length > 0) ||
    (req.notContains !== undefined && req.notContains.length > 0) ||
    (req.exists !== undefined && req.exists.length > 0) ||
    (req.match !== undefined && Object.keys(req.match).length > 0) ||
    (req.not !== undefined && Object.keys(req.not).length > 0)
  );
}

/** Distinct `file` paths across every candidate's `requires`. */
function distinctRequiredPaths(candidates: readonly ContentFilterCandidate[]): string[] {
  const paths = new Set<string>();
  for (const c of candidates) {
    for (const req of c.requires ?? []) paths.add(req.file);
  }
  return [...paths];
}

/**
 * Verdict for one candidate given the resolved file map + per-path fetch errors.
 *
 * Every failing branch says whether it COULD NOT evaluate (`indeterminate`) or
 * evaluated to false. Only the last one — the engine matcher returning a clean
 * negative — is a definite exclusion; a fetch error, an oversize file, and a
 * matcher-reported indeterminate are all "nothing read the requirement".
 */
function verdictForCandidate(
  reqs: readonly LockContentRequirement[],
  files: Map<string, FileContentEntry>,
  errored: Map<string, string>,
): { pass: boolean; reason?: string; indeterminate?: boolean } {
  for (const req of reqs) {
    const fetchError = errored.get(req.file);
    if (fetchError !== undefined) {
      return {
        pass: false,
        reason: `${req.file}: fetch failed (${fetchError})`,
        indeterminate: true,
      };
    }
    // A file present without bytes (over the provider's inline size limit) is
    // INDETERMINATE for any byte-reading query — never "absent" or "empty".
    const entry = files.get(req.file);
    if (requirementNeedsBytes(req) && entry?.present === true && entry.bytes === undefined) {
      return {
        pass: false,
        reason: `${req.file}: content unavailable for matching (exceeds size limit)`,
        indeterminate: true,
      };
    }
  }

  const result = evaluateContentRequirements(reqs, files);
  if (result.indeterminate) {
    return { pass: false, reason: result.indeterminate, indeterminate: true };
  }
  if (!result.pass) return { pass: false, reason: 'content requirements not satisfied' };
  return { pass: true };
}

/**
 * Filter candidates by their declarative content requirements.
 *
 * Gathers each distinct `(repo, sha, path)` once via the cache, evaluates every
 * candidate's `requires`, and returns the survivors (pass) split from the
 * dropped (fail / indeterminate, each logged with its reason). A candidate with
 * no `requires` always survives without any fetch (the fast path — like an empty
 * `paths` filter). When a candidate has `requires` but no fetcher/cache is
 * available, it is dropped as indeterminate (fail-visible), never dispatched
 * unfiltered.
 */
export async function filterByContentRequirements<C extends ContentFilterCandidate>(
  candidates: readonly C[],
  event: ContentFilterEvent,
  opts: ContentFilterOptions,
): Promise<ContentFilterResult<C>> {
  const survivors: C[] = [];
  const dropped: DroppedCandidate[] = [];

  const drop = (name: string, reason: string, indeterminate = false): void => {
    dropped.push({ name, reason, indeterminate });
    logger.info('Content requirement dropped candidate', {
      candidate: name,
      reason,
      indeterminate,
      repo: event.repo,
      sha: event.sha,
      deliveryId: opts.deliveryId,
    });
  };

  const anyRequires = candidates.some((c) => (c.requires?.length ?? 0) > 0);
  if (!anyRequires) return { survivors: [...candidates], dropped };

  // A requires-bearing candidate cannot be evaluated without both a fetcher and
  // a cache — drop it fail-visible rather than dispatch unfiltered.
  if (!opts.fetcher || !opts.cache) {
    for (const c of candidates) {
      if ((c.requires?.length ?? 0) > 0) {
        // Indeterminate, not excluded: nothing ever read the requirement.
        drop(c.name, 'no file-contents fetcher available for this provider', true);
      } else {
        survivors.push(c);
      }
    }
    return { survivors, dropped };
  }
  const { fetcher, cache } = opts;

  // Fetch each distinct required path once.
  const files = new Map<string, FileContentEntry>();
  const errored = new Map<string, string>();
  for (const path of distinctRequiredPaths(candidates)) {
    try {
      files.set(path, await cache.get(fetcher, event.repo, event.sha, path));
    } catch (err) {
      errored.set(path, toErrorMessage(err));
    }
  }

  for (const c of candidates) {
    const reqs = c.requires ?? [];
    if (reqs.length === 0) {
      survivors.push(c);
      continue;
    }
    const verdict = verdictForCandidate(reqs, files, errored);
    if (verdict.pass) survivors.push(c);
    else {
      drop(c.name, verdict.reason ?? 'content requirements not satisfied', verdict.indeterminate);
    }
  }

  return { survivors, dropped };
}
