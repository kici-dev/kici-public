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
      version: '1.2.9',
      platform: 'linux',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.2.9.tgz',
      sha256: 'cc5912bf3748daf3aa9aa5a60a2b63b68d985367d2af72ebb1db65a8c95d6d8d',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'linux-arm64': {
      name: 'rolldown',
      version: '1.2.9',
      platform: 'linux',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.2.9.tgz',
      sha256: '3c1356d59dea6c214370445893e269c6c88e2f74f310e8a21487c560ac82b508',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-x64': {
      name: 'rolldown',
      version: '1.2.9',
      platform: 'darwin',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.2.9.tgz',
      sha256: 'a37d9166d018006a02a9694d8b0b8adc6675fd2702553d0ffa6d93b7109dc10a',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-arm64': {
      name: 'rolldown',
      version: '1.2.9',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.2.9.tgz',
      sha256: '7b7da204879507a070d723323439f107d879cb8e11a4f2e2f0a9d3ee81ffbf80',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-x64': {
      name: 'rolldown',
      version: '1.2.9',
      platform: 'win32',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.2.9.tgz',
      sha256: 'eab52dc8846b438bb55727b65883b31d1716f686d3740f4ce4d18a5690fc1508',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-arm64': {
      name: 'rolldown',
      version: '1.2.9',
      platform: 'win32',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.2.9.tgz',
      sha256: 'c0249bb3cae06c97045294b28cd1bc2446ea60db02ccc20c7d4bc456cfcdad18',
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
