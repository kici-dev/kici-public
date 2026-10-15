/**
 * The installer's image reference, from the digest record at the package root.
 * The ref is pinned to the manifest-list digest, so a `docker`/`podman pull`
 * of substituted bits fails. Without a record (a dev tree that never ran a
 * release) or the image in it, it falls back to the moving `:latest` tag and
 * warns.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Component } from './instance/types.js';

const QUAY_PREFIX = 'quay.io/kici-dev';

const RECORD_FILENAME = 'installer-image-digests.json';

interface DigestRecord {
  version: string;
  images: Record<string, string>;
}

/** Climbs to the record: three dirs up from src/cli/service, one from the dist bundle. */
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

/** Null when the record is missing, unreadable, or lacks the image. */
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

/** The digest-pinned installer image ref, else `:latest` with a warning. */
export function resolveImageRef(name: string, opts: { filePath?: string } = {}): string {
  const pinned = recordedImage(name, opts);
  if (pinned) return `${QUAY_PREFIX}/${name}:${pinned.version}@${pinned.digest}`;
  console.warn(
    `[kici] no recorded manifest-list digest for ${name}; pinning the mutable :latest tag. ` +
      `Reinstall from a released kici-admin to get a digest-pinned image.`,
  );
  return `${QUAY_PREFIX}/${name}:latest`;
}
