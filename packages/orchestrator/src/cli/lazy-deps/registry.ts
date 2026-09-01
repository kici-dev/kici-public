/**
 * Metadata registry for lazy dependencies.
 *
 * Each entry describes a downloadable dependency with platform/arch variants,
 * URLs, SHA-256 integrity hashes, and extraction details.
 */

/** Metadata for a single lazy dependency variant. */
export interface LazyDep {
  /** Dependency name (e.g., "rolldown", "shawl"). */
  name: string;
  /** Version string. */
  version: string;
  /** Target Node.js platform. */
  platform: NodeJS.Platform;
  /** Target architecture (x64, arm64). */
  arch: string;
  /** Download URL. */
  url: string;
  /** Expected SHA-256 hash of the downloaded archive. */
  sha256: string;
  /** Relative path inside the archive to the binary/directory. */
  extractPath: string;
  /** Archive type for extraction. */
  archiveType: 'tar.gz' | 'zip' | 'binary';
}

/**
 * Platform+arch key used for variant lookup.
 * Format: `${platform}-${arch}` (e.g., "linux-x64", "darwin-arm64").
 */
type VariantKey = `${NodeJS.Platform}-${string}`;

/** Registry of all lazy dependencies keyed by name, then platform-arch. */
export const LAZY_DEPS: Record<string, Record<VariantKey, LazyDep>> = {
  rolldown: {
    'linux-x64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'linux',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.2.6.tgz',
      sha256: '4c4aa3cc78740157cba6fd998c07910a3451d3c288be80f66fa9ccb2a263c7eb',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'linux-arm64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'linux',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.2.6.tgz',
      sha256: '28bf36b0bb214d22c6548d2ca9d6e44a201c2b1b2e236283335fc9cf51839456',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-x64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'darwin',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.2.6.tgz',
      sha256: '7922d32b1097b0ea560b49dfafa82ef723ec03c6b4de88ba189fa04fe3d04570',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-arm64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.2.6.tgz',
      sha256: 'b692f549227b1e62b3435c759e1f1e9c8e81f00a91137e4d5a26b1465dc42914',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-x64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'win32',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.2.6.tgz',
      sha256: '23ccf60b4227220d809916ce75b3e4fdb8b6aa0e6cd844efc48c25a2cfe92581',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-arm64': {
      name: 'rolldown',
      version: '1.2.6',
      platform: 'win32',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.2.6.tgz',
      sha256: '8878ba48d8a241ed63892cbbbc483b01b97088756f195e95927bc1733b9fc6b9',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
  },
  shawl: {
    'win32-x64': {
      name: 'shawl',
      version: '1.9.0',
      platform: 'win32',
      arch: 'x64',
      url: 'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-win64.zip',
      sha256: 'f883c5d09c9beae2efaeabd8513e7d3f57cd1d0864cec3df4f4a7b6ee904351c',
      extractPath: 'shawl.exe',
      archiveType: 'zip',
    },
  },
};

/**
 * Get dependency metadata for the current (or specified) platform and architecture.
 *
 * @param name - Dependency name (e.g., "rolldown", "shawl")
 * @param platform - Override platform (default: os.platform())
 * @param arch - Override arch (default: process.arch)
 * @throws If the dependency or variant is not found in the registry
 */
export function getDepMetadata(name: string, platform?: NodeJS.Platform, arch?: string): LazyDep {
  const dep = LAZY_DEPS[name];
  if (!dep) {
    throw new Error(`Unknown lazy dependency: ${name}`);
  }

  const plat = platform ?? (process.platform as NodeJS.Platform);
  const ar = arch ?? process.arch;
  const key = `${plat}-${ar}` as VariantKey;

  const variant = dep[key];
  if (!variant) {
    throw new Error(`No ${name} variant for ${key}. Available: ${Object.keys(dep).join(', ')}`);
  }

  return variant;
}
