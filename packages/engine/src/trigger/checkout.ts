/**
 * The lock form of a job's `checkout` option, the record of what a `kici run
 * remote` overlay's `.git` provides, and the warning a job gets when that
 * record holds less history than the job asks for.
 *
 * The SDK's `checkout` takes `true`, `false` or `{ fetchDepth?, fetchTags? }`.
 * The lock keeps the boolean `checkout` key for `true`/`false` (an older agent
 * reads it with `=== false`) and carries the object form in a separate
 * `checkoutOptions` key, which an older agent ignores and clones at depth 1.
 *
 * This module imports only `zod`, so it stays browser-safe for the barrel.
 */

import { z } from 'zod';

/** Clone depth and tag policy of a job's checkout, as the lock carries it. */
export interface LockCheckoutOptions {
  /** Commits of history to fetch. 1 (default) = shallow; 0 = full history with every branch and tag. */
  readonly fetchDepth?: number;
  /** Unset: git's default tags. true: every tag. false: no tags. */
  readonly fetchTags?: boolean;
}

/**
 * Unknown keys are stripped, not rejected: an agent that meets an option a
 * newer compiler added still honours the options it knows.
 */
export const lockCheckoutOptionsSchema: z.ZodType<LockCheckoutOptions> = z.object({
  fetchDepth: z.number().int().min(0).optional(),
  fetchTags: z.boolean().optional(),
});

/**
 * Map a job's `checkout` option to its lock keys: a boolean stays in
 * `checkout`, a non-empty object goes to `checkoutOptions`, and an unset or
 * empty object emits nothing (the default checkout).
 */
export function lockCheckoutFields(checkout: boolean | LockCheckoutOptions | undefined): {
  checkout?: boolean;
  checkoutOptions?: LockCheckoutOptions;
} {
  if (checkout === undefined) return {};
  if (typeof checkout === 'boolean') return { checkout };
  const options: { fetchDepth?: number; fetchTags?: boolean } = {};
  if (checkout.fetchDepth !== undefined) options.fetchDepth = checkout.fetchDepth;
  if (checkout.fetchTags !== undefined) options.fetchTags = checkout.fetchTags;
  return Object.keys(options).length === 0 ? {} : { checkoutOptions: options };
}

/**
 * Read a `checkoutOptions` value from a lock job or a job config. Returns
 * `undefined` when it is absent or does not match the schema, so the reader
 * falls back to the default checkout.
 */
export function parseLockCheckoutOptions(value: unknown): LockCheckoutOptions | undefined {
  if (value === undefined) return undefined;
  const parsed = lockCheckoutOptionsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** What a `kici run remote` overlay's `.git` provides; written by the CLI into the overlay manifest. */
export interface OverlayGitRecord {
  /** Commits of history the shipped `.git` holds. 0 = full history. */
  readonly fetchDepth: number;
  /** True when the shipped `.git` carries every tag. */
  readonly allTags: boolean;
}

/** Not strict: a newer CLI may add keys an older agent keeps and ignores. */
export const overlayGitRecordSchema: z.ZodType<OverlayGitRecord> = z.object({
  fetchDepth: z.number().int().min(0),
  allTags: z.boolean(),
});

/**
 * The warning a `kici run remote` job gets when its checkout options ask for
 * more git history than the CLI shipped in the overlay's `.git`. The job still
 * runs; the line names the `kici run remote` flags that would ship enough.
 */
const HISTORY_GAP_PREFIX = '[kici] This job asks for more history than this run shipped';

/**
 * One log line naming each gap between the job's checkout options and the
 * shipped `.git`, or `null` when the shipped history covers the request or
 * the overlay carries no record (a CLI that ships the developer's raw `.git`).
 *
 * `fetchDepth: 0` asks for every tag unless `fetchTags` is false. That
 * implied tag request is not reported beside a depth gap, because
 * `--git-depth 0` ships every tag.
 */
export function describeHistoryGap(
  requested: LockCheckoutOptions | undefined,
  shipped: OverlayGitRecord | undefined,
): string | null {
  if (!shipped) return null;
  const depth = requested?.fetchDepth;
  const fetchTags = requested?.fetchTags;

  const depthGap =
    depth !== undefined && shipped.fetchDepth !== 0 && (depth === 0 || depth > shipped.fetchDepth);
  const impliedTags = depth === 0 && fetchTags === undefined;
  const tagsGap = !shipped.allTags && (fetchTags === true || (impliedTags && !depthGap));

  const gaps: string[] = [];
  const flags: string[] = [];
  if (depthGap) {
    gaps.push(`fetchDepth ${depth} requested, depth ${shipped.fetchDepth} shipped`);
    flags.push(`--git-depth ${depth}`);
  }
  if (tagsGap) {
    gaps.push('all tags requested, not shipped');
    flags.push('--git-tags');
  }
  if (gaps.length === 0) return null;
  return `${HISTORY_GAP_PREFIX} (${gaps.join('; ')}). Re-run kici run remote with ${flags.join(' ')}.`;
}
