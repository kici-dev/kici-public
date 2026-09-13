/**
 * Bounds vitest's worker count against the other vitest processes on this box.
 *
 * An 8-core machine running four packages' suites at vitest's default width
 * spawns ~28 workers. Starved workers miss timers, so tests that pass in 4.4s
 * serially fail with timeout-shaped errors — and inside a drain that false RED
 * costs a full re-verify under the exclusive mutex.
 *
 * The cap is a claim against a machine-wide budget rather than a constant,
 * because the contention is not all ours: concurrent sessions run this same
 * repository's suites, and each one imports this module, so each one registers.
 * A load-average heuristic cannot see them in time — it lags by a minute, so a
 * burst of simultaneous starts would each observe an idle box and each take the
 * full width, which is exactly the burst that produces the failures.
 *
 * Set VITEST_MAX_WORKERS explicitly to opt out; the value is then left alone and
 * nothing is registered.
 *
 * Two properties it does NOT have, both load-bearing when reading a slow suite:
 *
 *  - It bounds how wide ONE process runs; it does not hold the sum to the
 *    budget. Each process claims against the claimants it can see at the moment
 *    it starts, so staggered arrivals claim 7 + 3 + 2 + 1 — 13 workers at four
 *    suites, 16 at seven, against a budget of 7.
 *  - A cap is never widened once claimed. A suite that starts while the box is
 *    busy keeps its narrow share for its whole run, and stays throttled long
 *    after the box frees: measured 6.85 s solo at cap 7 against 12.49 s at cap
 *    3, a 1.82x cost that in a drain lands on the exclusive VERIFY stage and so
 *    extends the mutex hold that serialises every other wish. There is no cheap
 *    mitigation — vitest reads VITEST_MAX_WORKERS exactly once during config
 *    resolution, and `pool.setMaxWorkers` takes the already-resolved config, so
 *    no config hook can reach a running pool.
 *
 * Both are accepted: re-balancing pools that are already running costs more than
 * the contention it would relieve, and every over- or under-shoot is bounded and
 * self-corrects as processes turn over.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

/**
 * Outside the repository on purpose: it can never appear in a diff, can never be
 * committed, and dies with the machine rather than outliving a run. Same
 * reasoning as the drain's VERIFY mutex at `/tmp/kici-drain-verify.lock`.
 */
export const REGISTRY_DIR = '/tmp/kici-vitest-workers';

/** Workers to divide up: every core but one, so the box stays answerable. */
export function budget(cores: number = availableParallelism()): number {
  return Math.max(1, cores - 1);
}

/** One claimant's slice of the budget, never zero and never more than all of it. */
export function share(total: number, claimants: number): number {
  const whole = Math.max(1, total);
  const n = Math.max(1, claimants);
  return Math.min(whole, Math.max(1, Math.floor(whole / n)));
}

/** True when a process with this pid still exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The registry's live pids, deleting every entry that is not one.
 *
 * Reaping on read is what makes a `kill -9` harmless: a dead process's entry
 * shrinks nobody's share past the next claim.
 *
 * Deletion is best-effort: an entry another user owns raises EACCES, and this
 * runs at config-eval time, where an uncaught throw fails the whole vitest run.
 * An entry that cannot be deleted is still not counted — it names no live
 * process either way, so skipping it keeps the share correct even when the
 * registry cannot be cleaned.
 */
export function liveClaimants(dir: string, alive: (pid: number) => boolean): number[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) {
      try {
        rmSync(path.join(dir, name), { force: true });
      } catch {
        // Not ours to delete. Leave it and carry on without counting it.
      }
      continue;
    }
    live.push(pid);
  }
  return live;
}

/**
 * Claim a slice and publish it as VITEST_MAX_WORKERS. Returns the cap, or
 * `undefined` when this process does not claim one.
 *
 * Registration happens before the count, so the caller is always included and
 * two simultaneous starts cannot both read zero.
 *
 * The share is computed once and never revised, which errs in both directions.
 * An early starter keeps the wider share it claimed before the others appeared,
 * so the concurrent total overshoots the budget. A late starter keeps the narrow
 * share it claimed against a busy box even after that box empties, and pays for
 * it for the rest of its run — the more expensive of the two, and the one the
 * module header quantifies.
 */
export function claim(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = REGISTRY_DIR,
  pid: number = process.pid,
): number | undefined {
  // An explicit value is a deliberate choice; honour it and stay out of the
  // registry, so an opted-out run does not shrink anyone else's share either.
  if (env.VITEST_MAX_WORKERS) return undefined;
  // A pool worker inherits the resolved config; only the main process decides.
  if (env.VITEST_POOL_ID) return undefined;

  mkdirSync(dir, { recursive: true });
  const self = path.join(dir, String(pid));
  try {
    writeFileSync(self, '', { flag: 'wx' });
  } catch {
    // Already registered — a re-entrant config evaluation. Keep the entry.
  }
  const cap = share(budget(), liveClaimants(dir, pidAlive).length);
  env.VITEST_MAX_WORKERS = String(cap);
  process.once('exit', () => rmSync(self, { force: true }));
  return cap;
}
