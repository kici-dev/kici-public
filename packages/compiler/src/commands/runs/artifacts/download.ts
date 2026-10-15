/** kici runs artifacts download — fetch one artifact (by name) or every artifact of a run. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { logger, sha256, toErrorMessage } from '@kici-dev/core';
import { ArtifactNameSchema, type ArtifactListItem } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../../remote/dashboard-client.js';
import { extractArtifactTarball } from '../../../remote/artifact-extract.js';
import { isCaseInsensitiveDir } from '../../../remote/fs-case.js';

export interface RunsArtifactsDownloadOptions {
  archive?: boolean;
  output?: string;
}

const ARCHIVE_EXTENSION = '.tar.gz';

export function destBasename(name: string, archive: boolean): string {
  return archive ? `${name}${ARCHIVE_EXTENSION}` : name;
}

/**
 * The form a case-insensitive filesystem looks a basename up by. The NFC pass
 * defends a widened name charset: `ArtifactNameSchema` is ASCII-only today, but
 * HFS+ stores NFD and APFS folds case while preserving normalisation, so a
 * non-ASCII name would collide on those volumes without it.
 */
export function foldBasename(basename: string): string {
  return basename.normalize('NFC').toLowerCase();
}

/**
 * Basenames a case-insensitive filesystem resolves to one path, in
 * first-appearance order, each group sorted; a basename with no partner is
 * not reported.
 */
export function findCaseCollisions(basenames: string[]): string[][] {
  const byFold = new Map<string, Set<string>>();
  for (const basename of basenames) {
    const fold = foldBasename(basename);
    const group = byFold.get(fold);
    if (group) group.add(basename);
    else byFold.set(fold, new Set([basename]));
  }
  return [...byFold.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}

/**
 * Verifies the sha-256. NO `Authorization` header: `downloadUrl` is a
 * presigned object-storage GET, and sending the Platform PAT would leak it to
 * the storage host. The bytes never transit the Platform.
 */
async function fetchArtifactBytes(entry: ArtifactListItem): Promise<Buffer> {
  if (!entry.downloadUrl) {
    throw new Error(
      `artifact "${entry.name}" has no download URL (the stored object is missing or expired)`,
    );
  }
  const res = await fetch(entry.downloadUrl);
  if (!res.ok) {
    throw new Error(`download of "${entry.name}" failed (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== entry.sha256) {
    throw new Error(
      `artifact "${entry.name}" checksum mismatch: expected ${entry.sha256}, got ${actual}`,
    );
  }
  return buf;
}

/**
 * Uploads validate names against {@link ArtifactNameSchema}, so an invalid one
 * comes from a broken or hostile peer. The name becomes a path component, so it
 * is checked before the join: an unchecked `../…` would let a list response
 * write anywhere on the caller's filesystem.
 */
function assertPathSafeName(name: string): void {
  if (!ArtifactNameSchema.safeParse(name).success) {
    throw new Error(
      `listed artifact "${name}" is not a valid artifact name — refusing to write it under the output directory`,
    );
  }
}

/**
 * Refuses the whole invocation when two targets would land on one path.
 * Artifact names are case-sensitive (`bundle` and `Bundle` can coexist), but a
 * case-insensitive filesystem would merge the extractions or overwrite the
 * archive. The filesystem is probed only once a fold collision exists, so a
 * case-sensitive directory downloads both. A probe that cannot answer counts as
 * case-insensitive: refusing beats losing data.
 */
async function assertNoCaseCollisions(
  targets: ArtifactListItem[],
  outDir: string,
  archive: boolean,
): Promise<void> {
  const groups = findCaseCollisions(targets.map((t) => destBasename(t.name, archive)));
  if (groups.length === 0) return;

  let probeError: unknown;
  let caseInsensitive = true;
  try {
    caseInsensitive = await isCaseInsensitiveDir(outDir);
  } catch (err) {
    probeError = err;
  }
  if (!caseInsensitive) return;

  const pairs = groups.map((g) => g.map((basename) => `"${basename}"`).join(' and ')).join('; ');
  const consequence = archive
    ? 'writing both would overwrite one file with the other'
    : 'extracting both would merge them into one directory';
  const reason =
    probeError !== undefined
      ? `the output directory ${outDir} could not be checked for case sensitivity (${toErrorMessage(probeError)})`
      : `the output directory ${outDir} is on a case-insensitive filesystem`;
  throw new Error(
    `this run holds artifacts whose names differ only in case: ${pairs} — ${consequence}, and ${reason}. ` +
      'Download them one at a time into separate directories: kici runs artifacts download <run-id> <name> -o <dir>',
  );
}

async function writeOne(entry: ArtifactListItem, outDir: string, archive: boolean): Promise<void> {
  assertPathSafeName(entry.name);
  const buf = await fetchArtifactBytes(entry);
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, destBasename(entry.name, archive));
  if (archive) {
    await writeFile(dest, buf);
    console.log(pc.green(`✓ ${entry.name} → ${dest}`));
    return;
  }
  await extractArtifactTarball(buf, dest);
  console.log(pc.green(`✓ ${entry.name} → ${dest}/`));
}

function resolveTargets(
  artifacts: ArtifactListItem[],
  name: string | undefined,
  runId: string,
): ArtifactListItem[] {
  if (!name) return artifacts;
  const match = artifacts.find((a) => a.name === name);
  if (match) return [match];
  const names = artifacts.map((a) => a.name).join(', ') || '(none)';
  throw new Error(`artifact "${name}" not found in run ${runId}. Available: ${names}`);
}

export async function runsArtifactsDownloadCommand(
  runId: string,
  name: string | undefined,
  options: RunsArtifactsDownloadOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const { artifacts } = await client.listArtifacts(runId);
    const outDir = options.output ?? process.cwd();
    // One predicate shared by target resolution, the collision guard and the
    // missing-object tolerance. `resolveTargets` treats "" as "everything", so
    // `name === undefined` here would let `download <run-id> ""` download the
    // whole run with the guard off.
    const downloadingAll = !name;
    const targets = resolveTargets(artifacts, name, runId);

    if (targets.length === 0) {
      console.log(pc.gray('No artifacts for this run.'));
      return true;
    }

    // Validate every name before the first fetch, so a hostile name leaves no
    // earlier artifacts on disk.
    for (const entry of targets) assertPathSafeName(entry.name);
    if (downloadingAll) {
      // An entry whose object is gone is skipped, not written, so it cannot collide.
      await assertNoCaseCollisions(
        targets.filter((t) => t.downloadUrl),
        outDir,
        options.archive ?? false,
      );
    }

    // Downloading every artifact warns past a missing object; a named artifact
    // that cannot be fetched is a failure.
    let failures = 0;
    for (const entry of targets) {
      if (downloadingAll && !entry.downloadUrl) {
        logger.warn(
          pc.yellow(`! ${entry.name} skipped — no download URL (object missing or expired)`),
        );
        failures++;
        continue;
      }
      await writeOne(entry, outDir, options.archive ?? false);
    }
    return failures < targets.length;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
