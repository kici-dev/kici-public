/**
 * Cache maintenance commands for kici-admin (orchestrator side).
 *
 *   cache purge-legacy [--yes] [--org <id>]   Remove objects under the retired cache layouts
 *
 * The CLI talks **directly** to the configured cache storage backend — the same
 * `KICI_STORAGE_*` configuration the orchestrator runs with — and never through
 * the orchestrator HTTP admin API: the objects it removes are ones no running
 * process reads, so there is nothing for the process to mediate. No database
 * and no running orchestrator are needed.
 */

import type { Command } from 'commander';
import { formatBytes } from '@kici-dev/shared';
import { loadConfig } from '../../config.js';
import { createCacheStorage, generateSigningSecret } from '../../storage/index.js';
import type { CacheStorage } from '../../storage/types.js';
import {
  LEGACY_PREFIXES,
  classifyLegacyKeys,
  type LegacyPrefix,
} from '../../cache/legacy-prefixes.js';
import { sanitizeSegment } from '../../cache/user-cache.js';

/** Build the cache storage client from the orchestrator config (S3 or filesystem). */
export function resolveCacheStorage(): CacheStorage {
  // Packaging scope reads only the object-storage config, so the operator's
  // shell does not have to carry the runtime coordinator / Platform env.
  const config = loadConfig('packaging');
  const ttlMs = config.cacheTtlDays * 86_400_000;
  if (config.storage?.type === 's3') {
    return createCacheStorage({
      type: 's3',
      bucket: config.storage.bucket!,
      prefix: config.storage.prefix ?? '',
      ttlMs,
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      externalEndpoint: config.storage.externalEndpoint,
      uploadEndpoint: config.storage.uploadEndpoint,
      forcePathStyle: config.storage.forcePathStyle,
    });
  }
  if (config.storage?.type === 'filesystem') {
    // The purge only lists and deletes, so the URL-signing inputs are never
    // used; a fresh secret satisfies the constructor without reading state.
    return createCacheStorage({
      type: 'filesystem',
      basePath: config.storage.fsBasePath!,
      ttlMs,
      baseUrl: config.storage.fsBaseUrl ?? `http://127.0.0.1:${config.port}`,
      signingSecret: generateSigningSecret(),
    });
  }
  throw new Error(
    'No cache storage configured. Set KICI_STORAGE_TYPE and the matching KICI_STORAGE_* variables.',
  );
}

export interface PurgeLegacyOptions {
  storage: CacheStorage;
  /** Delete the matched objects. Off = dry run: list and count only. */
  apply: boolean;
  /** Narrow the sweep to one org's user-cache prefix (`cache/<org>/`). */
  org?: string;
}

export interface PurgeLegacyPrefixSummary {
  count: number;
  bytes: number;
}

export interface PurgeLegacySummary {
  applied: boolean;
  perPrefix: Map<LegacyPrefix, PurgeLegacyPrefixSummary>;
  totalCount: number;
  totalBytes: number;
}

/**
 * Find every object under the retired cache layouts and, with `apply`, delete
 * it. Sizes come from a stat of each candidate — the listing carries none —
 * and a candidate that vanishes between the listing and the stat counts as
 * zero bytes rather than failing the sweep.
 *
 * `org` limits the scan to that org's `cache/<org>/` prefix. The retired source
 * and dependency layouts carry no org segment, so an org-scoped sweep leaves
 * them untouched.
 */
export async function purgeLegacyCache(opts: PurgeLegacyOptions): Promise<PurgeLegacySummary> {
  const scanPrefixes: readonly string[] =
    opts.org === undefined ? LEGACY_PREFIXES : [`cache/${sanitizeSegment(opts.org)}/`];
  const listing: string[] = [];
  for (const prefix of scanPrefixes) listing.push(...(await opts.storage.list(prefix)));

  const perPrefix = new Map<LegacyPrefix, PurgeLegacyPrefixSummary>();
  let totalCount = 0;
  let totalBytes = 0;
  for (const [prefix, keys] of classifyLegacyKeys(listing)) {
    let bytes = 0;
    for (const key of keys) {
      bytes += (await opts.storage.getObjectSize(key)) ?? 0;
      if (opts.apply) await opts.storage.delete(key);
    }
    perPrefix.set(prefix, { count: keys.length, bytes });
    totalCount += keys.length;
    totalBytes += bytes;
  }
  return { applied: opts.apply, perPrefix, totalCount, totalBytes };
}

function renderSummary(summary: PurgeLegacySummary): string[] {
  if (summary.totalCount === 0) {
    return ['No objects under the retired cache layouts.'];
  }
  const lines = [
    summary.applied
      ? 'Deleted objects under the retired cache layouts:'
      : 'Objects under the retired cache layouts (dry run, nothing deleted):',
  ];
  for (const [prefix, { count, bytes }] of summary.perPrefix) {
    lines.push(`  ${prefix.padEnd(8)} ${String(count).padStart(6)} objects  ${formatBytes(bytes)}`);
  }
  lines.push(
    summary.applied
      ? `Deleted ${summary.totalCount} objects (${formatBytes(summary.totalBytes)}).`
      : `${summary.totalCount} objects (${formatBytes(summary.totalBytes)}). Run again with --yes to delete them.`,
  );
  return lines;
}

/** Seams the tests replace: where the storage comes from and where output goes. */
export interface CacheCommandDeps {
  resolveStorage: () => CacheStorage;
  out: (line: string) => void;
}

export function registerCacheCommands(
  program: Command,
  deps: CacheCommandDeps = { resolveStorage: resolveCacheStorage, out: console.log },
): void {
  const cache = program
    .command('cache')
    .description('Maintain the orchestrator object-storage cache (direct storage access)');

  cache
    .command('purge-legacy')
    .description(
      'Remove cache objects written under the retired key layouts. DRY RUN by default — pass --yes to delete.',
    )
    .option('--yes', 'Delete the matched objects (default is a dry run that only counts them)')
    .option('--org <id>', 'Only sweep this org user-cache prefix (cache/<org>/)')
    .action(async (opts: { yes?: boolean; org?: string }) => {
      try {
        const summary = await purgeLegacyCache({
          storage: deps.resolveStorage(),
          apply: opts.yes === true,
          org: opts.org,
        });
        for (const line of renderSummary(summary)) deps.out(line);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }
    });
}
