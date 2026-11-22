/**
 * The installer's image reference, from the digest record at the package root.
 * The ref is pinned to the manifest-list digest, so a `docker`/`podman pull`
 * of substituted bits fails. Without a record (a dev tree that never ran a
 * release) or the image in it, it falls back to the moving `:latest` tag and
 * warns.
 *
 * A registry prefix (`--image-registry`, env `KICI_IMAGE_REGISTRY`) replaces
 * `quay.io/kici-dev` for an install that pulls from its own registry mirror. The
 * digest stays, so the mirror cannot substitute the content.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Component } from './instance/types.js';

const QUAY_PREFIX = 'quay.io/kici-dev';

/** The setting that names a registry prefix in place of `quay.io/kici-dev`. */
export const IMAGE_REGISTRY_ENV = 'KICI_IMAGE_REGISTRY';

/**
 * The OCI distribution reference grammar (github.com/distribution/reference, reference.go,
 * read 2026-11-08): `domain := host [':' port-number]`, a host of dot-separated
 * `domain-component`s, and lowercase `path-component`s.
 */
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = new RegExp(`^${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?$`);
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[_.]|__|-+)[a-z0-9]+)*$/;

/**
 * A registry prefix such as `registry.internal.example/kici-dev`, without a trailing `/`;
 * `undefined` for an empty value. A port is allowed on the host (`registry:5000/kici-dev`).
 * The prefix must be a domain and path components of an OCI reference, so the image line the
 * install writes into its compose file is one a runtime pulls, and no YAML-special character
 * (`*`, `&`, `{`, `#`) reaches that hand-built file.
 * @throws If the value is a URL, carries a tag or a digest, or has a segment outside the grammar.
 */
export function normalizeImageRegistry(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  const [domain = '', ...segments] = trimmed.split('/');
  // fails-when: a value outside the reference grammar reaches the compose file's image line
  const valid = DOMAIN.test(domain) && segments.every((seg) => PATH_COMPONENT.test(seg));
  if (!valid) {
    throw new Error(
      `--image-registry / ${IMAGE_REGISTRY_ENV} must be an image prefix such as ` +
        `registry.internal.example/kici-dev (no scheme, tag or digest), got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}

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

/**
 * The digest-pinned installer image ref, else `:latest` with a warning. `opts.registry`
 * replaces the `quay.io/kici-dev` prefix ({@link normalizeImageRegistry}).
 */
export function resolveImageRef(
  name: string,
  opts: { filePath?: string; registry?: string } = {},
): string {
  const prefix = normalizeImageRegistry(opts.registry) ?? QUAY_PREFIX;
  const pinned = recordedImage(name, opts);
  if (pinned) return `${prefix}/${name}:${pinned.version}@${pinned.digest}`;
  console.warn(
    `[kici] no recorded manifest-list digest for ${name}; pinning the mutable :latest tag. ` +
      `Reinstall from a released kici-admin to get a digest-pinned image.`,
  );
  return `${prefix}/${name}:latest`;
}
