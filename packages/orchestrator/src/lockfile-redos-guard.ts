/**
 * Lock-load ReDoS revalidation.
 *
 * Re-validates every regex matcher in a fetched lock file before it is cached
 * or dispatched. Defense-in-depth against a hand-edited or non-compiled lock
 * that smuggled a ReDoS-prone pattern past the compile-time gate: the compiler
 * runs the same `assertMatchersSafe` check when it emits the lock, but the
 * orchestrator does not trust that the lock it fetched was produced by our
 * compiler.
 */

import { assertMatchersSafe } from '@kici-dev/engine/labels/compile';
import { isLockStaticJob } from '@kici-dev/engine';
import type { LabelMatcher, LockFile } from '@kici-dev/engine';

/**
 * Walk every static job's `runsOn` / `excludeLabels` / `runsOnAll` matchers and
 * throw if any regex matcher is ReDoS-prone. Dynamic job generators carry no
 * static routing matchers (they materialize jobs at eval time, which re-runs the
 * compile-time gate), so only static jobs are checked.
 */
export function assertLockFileRegexesSafe(lockFile: LockFile): void {
  for (const wf of lockFile.workflows ?? []) {
    for (const job of wf.jobs ?? []) {
      if (!isLockStaticJob(job)) continue;
      const ctx = `lock workflow '${wf.name}' job '${job.name}'`;
      if (job.runsOn) assertMatchersSafe(job.runsOn, `${ctx} runsOn`);
      if (job.excludeLabels) assertMatchersSafe(job.excludeLabels, `${ctx} excludeLabels`);
      if (job.runsOnAll) {
        for (const grp of job.runsOnAll.include ?? []) {
          assertMatchersSafe(grp as readonly LabelMatcher[], `${ctx} runsOnAll`);
        }
        if (job.runsOnAll.exclude) {
          assertMatchersSafe(job.runsOnAll.exclude, `${ctx} runsOnAll exclude`);
        }
      }
    }
  }
}
