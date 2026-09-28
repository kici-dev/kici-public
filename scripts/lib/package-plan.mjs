/**
 * What `scripts/package.mjs` builds: the components, the platforms, the two
 * package types, and the name of each archive. `package.mjs --list` prints the
 * plan without building it, which is how a release names its assets.
 */

/**
 * Components, each bundled from one entry point. `licenseDir` is the workspace
 * of the npm package the component ships as: its `LICENSE` becomes the
 * package's `LICENSE`.
 */
export const PACKAGE_TARGETS = [
  {
    entry: 'packages/orchestrator/src/server.ts',
    name: 'kici-orchestrator',
    licenseDir: 'packages/orchestrator',
  },
  {
    entry: 'packages/orchestrator/src/standalone.ts',
    name: 'kici-orchestrator-standalone',
    licenseDir: 'packages/orchestrator',
  },
  {
    entry: 'packages/orchestrator/src/cli/kici-admin.ts',
    name: 'kici-admin',
    licenseDir: 'packages/kici-admin',
  },
  { entry: 'packages/agent/src/server.ts', name: 'kici-agent', licenseDir: 'packages/agent' },
];

export const PACKAGE_PLATFORMS = [
  { os: 'linux', arch: 'x64', ext: '', launcherExt: '', archiveFormat: 'tar.gz' },
  { os: 'linux', arch: 'arm64', ext: '', launcherExt: '', archiveFormat: 'tar.gz' },
  { os: 'darwin', arch: 'x64', ext: '', launcherExt: '', archiveFormat: 'tar.gz' },
  { os: 'darwin', arch: 'arm64', ext: '', launcherExt: '', archiveFormat: 'tar.gz' },
  { os: 'win', arch: 'x64', ext: '.exe', launcherExt: '.cmd', archiveFormat: 'zip' },
  { os: 'win', arch: 'arm64', ext: '.exe', launcherExt: '.cmd', archiveFormat: 'zip' },
];

/** A full package embeds Node.js and npm; a light one runs on a cached Node.js. */
export const PACKAGE_TYPES = ['full', 'light'];

/** @param {{ os: string, arch: string }} platform */
export function platformLabel(platform) {
  return `${platform.os}-${platform.arch}`;
}

/**
 * The top-level directory inside an archive, and the archive name without its
 * extension.
 *
 * @param {string} targetName
 * @param {string} version
 * @param {{ os: string, arch: string }} platform
 * @param {string} type
 */
export function packageDirName(targetName, version, platform, type) {
  return `${targetName}-${version}-${platformLabel(platform)}${type === 'light' ? '-light' : ''}`;
}

/**
 * @param {string} targetName
 * @param {string} version
 * @param {{ os: string, arch: string, archiveFormat: string }} platform
 * @param {string} type
 */
export function archiveFileName(targetName, version, platform, type) {
  return `${packageDirName(targetName, version, platform, type)}.${platform.archiveFormat}`;
}

/**
 * The targets, platforms and types the CLI filters select. With neither type
 * flag, or with both, a run builds both types.
 *
 * @param {{ target?: string, platform?: string, light?: boolean, full?: boolean }} filters
 */
export function selectMatrix({ target, platform, light = false, full = false }) {
  const targets = target ? PACKAGE_TARGETS.filter((t) => t.name === target) : PACKAGE_TARGETS;
  if (targets.length === 0) {
    throw new Error(
      `unknown target "${target}". Available: ${PACKAGE_TARGETS.map((t) => t.name).join(', ')}`,
    );
  }
  const platforms = platform
    ? PACKAGE_PLATFORMS.filter((p) => platformLabel(p) === platform)
    : PACKAGE_PLATFORMS;
  if (platforms.length === 0) {
    throw new Error(
      `unknown platform "${platform}". Available: ${PACKAGE_PLATFORMS.map(platformLabel).join(', ')}`,
    );
  }
  const both = light === full;
  const types = PACKAGE_TYPES.filter((type) => both || (type === 'full' ? full : light));
  return { targets, platforms, types };
}

/**
 * Every archive a run produces, in build order: by target, then platform, then type.
 *
 * @param {{ version: string, targets: typeof PACKAGE_TARGETS,
 *   platforms: typeof PACKAGE_PLATFORMS, types: string[] }} matrix
 * @returns {Array<{ target: string, platform: string, type: string, file: string }>}
 */
export function planArchives({ version, targets, platforms, types }) {
  const planned = [];
  for (const t of targets) {
    for (const p of platforms) {
      for (const type of types) {
        planned.push({
          target: t.name,
          platform: platformLabel(p),
          type,
          file: archiveFileName(t.name, version, p, type),
        });
      }
    }
  }
  return planned;
}

/**
 * A packaging run succeeds only when it built every planned archive and
 * recorded no failure. `missing` names the planned archives it did not build.
 *
 * @param {{ planned: Array<{ file: string }>, built: string[], failures: string[] }} run
 */
export function packagingOutcome({ planned, built, failures }) {
  const builtSet = new Set(built);
  const missing = planned.filter((a) => !builtSet.has(a.file)).map((a) => a.file);
  return { exitCode: missing.length === 0 && failures.length === 0 ? 0 : 1, missing };
}

/**
 * The name of the container-image digest record in a package. The kici-admin
 * installer reads it from its package root to pin compose images by digest
 * (packages/orchestrator/src/cli/service/image-digests.ts).
 */
export const IMAGE_DIGEST_RECORD_FILE = 'installer-image-digests.json';

/** The components whose packages carry the image-digest record. */
export const IMAGE_DIGEST_RECORD_TARGETS = ['kici-admin'];

/**
 * Parse the image-digest record `--image-digest-record` names. It throws on a
 * record the installer could not use, so a malformed record fails the
 * packaging instead of shipping a kici-admin that pins `:latest`.
 *
 * @param {string} text the record file's content
 * @param {string} source the record's path, for the error message
 * @returns {{ version: string, images: Record<string, string> }}
 */
export function parseImageDigestRecord(text, source) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not JSON: ${err.message}`);
  }
  if (record === null || typeof record !== 'object' || typeof record.version !== 'string') {
    throw new Error(`${source} names no version`);
  }
  const images = record.images;
  if (
    images === null ||
    typeof images !== 'object' ||
    Object.keys(images).length === 0 ||
    Object.values(images).some((d) => typeof d !== 'string')
  ) {
    throw new Error(`${source} pins no image digest`);
  }
  return { version: record.version, images };
}
