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

/** Extension of the raw artifact archive written by `--archive`. */
const ARCHIVE_EXTENSION = '.tar.gz';

/** Basename an artifact takes under the output directory in the given mode. */
export function destBasename(name: string, archive: boolean): string {
  return archive ? `${name}${ARCHIVE_EXTENSION}` : name;
}

/**
 * Reduce a basename to the form a case-insensitive filesystem looks it up by.
 *
 * The NFC pass is deliberate defence for a widened artifact-name charset:
 * `ArtifactNameSchema` accepts ASCII only today, so no live name can differ by
 * normalisation — but HFS+ stores NFD and APFS folds case while preserving
 * normalisation, so a non-ASCII name would collide on those volumes without it.
 */
export function foldBasename(basename: string): string {
  return basename.normalize('NFC').toLowerCase();
}

/**
 * Group basenames that a case-insensitive filesystem resolves to one path.
 *
 * Groups appear in first-appearance order and each group is sorted; a basename
 * with no partner is not reported.
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
 * Fetch a presigned artifact URL into a Buffer and verify its sha-256.
 *
 * NO `Authorization` header: `downloadUrl` is a presigned object-storage GET,
 * and the PAT authenticates to the Platform, not to object storage — attaching
 * it would leak the credential to the storage host. The bytes therefore flow
 * CLI <-> object storage directly and never transit the Platform.
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
 * Refuse a listed name that is not a valid artifact name.
 *
 * Every name is validated against {@link ArtifactNameSchema} at upload, so a
 * response carrying one outside that contract comes from a broken or hostile
 * peer. The name becomes a path component under the output directory, so it is
 * checked before it is joined — an unchecked `../…` would let a list response
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
 * Refuse the whole invocation when two targets would land on the same path.
 *
 * Artifact names are case-sensitive, so a run can legitimately hold both
 * `bundle` and `Bundle`. On a filesystem that ignores case in path lookups the
 * two resolve to one path — the second extraction merges into the first's
 * directory, or overwrites its archive under `--archive`. The filesystem is
 * probed only once a fold collision is known to exist, so a case-sensitive
 * output directory downloads both exactly as before. A probe that cannot answer
 * is treated as case-insensitive: the collision is already certain, so the
 * unknown half is resolved towards refusing rather than towards losing data.
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

/** Fetch one entry and write it to `outDir`, extracted or as the raw archive. */
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

/** Resolve which listed artifacts the invocation targets. */
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
    // One predicate for "no name was given", shared by target resolution, the
    // collision guard, and the missing-object tolerance below. `resolveTargets`
    // treats an empty-string name as "download everything", so testing any of
    // the three against `name === undefined` instead would let
    // `download <run-id> "" -o <dir>` download the whole run with the guard off.
    const downloadingAll = !name;
    const targets = resolveTargets(artifacts, name, runId);

    if (targets.length === 0) {
      console.log(pc.gray('No artifacts for this run.'));
      return true;
    }

    // Validate the whole target set before the first byte is fetched: a hostile
    // name anywhere in the set refuses the invocation rather than leaving the
    // artifacts ahead of it on disk.
    for (const entry of targets) assertPathSafeName(entry.name);
    if (downloadingAll) {
      // Only entries the loop below will actually write can collide: one whose
      // object is gone is skipped, not written, so counting it would refuse a
      // download that was never going to put two artifacts on one path.
      await assertNoCaseCollisions(
        targets.filter((t) => t.downloadUrl),
        outDir,
        options.archive ?? false,
      );
    }

    // Downloading every artifact tolerates an individual entry whose object is
    // gone: warn and keep going. Naming a single artifact does not — a targeted
    // request that cannot be satisfied is a failure.
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
