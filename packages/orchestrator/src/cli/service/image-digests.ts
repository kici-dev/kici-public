/**
 * Resolves the customer installer's image reference from the digest record
 * shipped with this package (installer-image-digests.json at the package root).
 *
 * Emits a manifest-list-digest-pinned ref so a `docker`/`podman pull` verifies
 * the image hash — a registry that serves substituted bits fails the pull. When
 * the record is missing (a dev tree that never ran a release) or lacks the
 * image, falls back to the moving `:latest` tag and warns.
 *
 * The record resolves relative to this module's directory and works for both
 * layouts: the source tree (`src/cli/service/` → the JSON is three dirs up at
 * the package root) and the single-file bundle (`dist/cli.js` → one dir up).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Component } from './instance/types.js';

const QUAY_PREFIX = 'quay.io/kici-dev';

/** Filename of the committed digest record at the orchestrator package root. */
const RECORD_FILENAME = 'installer-image-digests.json';

interface DigestRecord {
  version: string;
  images: Record<string, string>;
}

/**
 * Climb from a starting directory looking for installer-image-digests.json.
 * Works for the source layout (src/cli/service → 3 up) and the single-file
 * bundle layout (dist → 1 up).
 */
function findRecordFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, RECORD_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The published image a component runs, whatever the service is named. */
export function installerImageName(component: Component): string {
  return `kici-${component}`;
}

/**
 * The recorded release and digest of an installer image, or null when the
 * record is missing, unreadable, or does not hold the image.
 */
function recordedImage(
  name: string,
  opts: { filePath?: string },
): { version: string; digest: string } | null {
  const file = opts.filePath ?? findRecordFile(import.meta.dirname);
  if (!file || !existsSync(file)) return null;
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as DigestRecord;
    const digest = rec.images?.[name];
    return digest && rec.version ? { version: rec.version, digest } : null;
  } catch {
    return null;
  }
}

/**
 * The release {@link resolveImageRef} pins `name` at, or null when it falls
 * back to the moving `:latest` tag.
 */
export function pinnedImageVersion(name: string, opts: { filePath?: string } = {}): string | null {
  return recordedImage(name, opts)?.version ?? null;
}

/**
 * Resolve `quay.io/kici-dev/<name>:<version>@sha256:<digest>` for an installer
 * image. Falls back to `:latest` (with a warning) when no recorded digest exists.
 */
export function resolveImageRef(name: string, opts: { filePath?: string } = {}): string {
  const pinned = recordedImage(name, opts);
  if (pinned) return `${QUAY_PREFIX}/${name}:${pinned.version}@${pinned.digest}`;
  console.warn(
    `[kici] no recorded manifest-list digest for ${name}; pinning the mutable :latest tag. ` +
      `Reinstall from a released kici-admin to get a digest-pinned image.`,
  );
  return `${QUAY_PREFIX}/${name}:latest`;
}
