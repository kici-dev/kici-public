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
      version: '1.1.3',
      platform: 'linux',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.1.3.tgz',
      sha256: '7759bc6da0140899e447345cb2467f5a4fb2c73d9cbac94a341b7a69e67f5cff',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'linux-arm64': {
      name: 'rolldown',
      version: '1.1.3',
      platform: 'linux',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.1.3.tgz',
      sha256: 'a1ab47becdde8e8d8f9176a0bdc938e6e76bf52c668ffb5287ea8b515048bb99',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-x64': {
      name: 'rolldown',
      version: '1.1.3',
      platform: 'darwin',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.1.3.tgz',
      sha256: 'eabb0140217ba45fc0d1de1a7cd59ba475a9c0cd2c207c9364fb58328478b878',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-arm64': {
      name: 'rolldown',
      version: '1.1.3',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.1.3.tgz',
      sha256: 'ddc152faf8328a44ee846c99cf945dbac45541ce2a6785f6b0707ad1c0ffe1f3',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-x64': {
      name: 'rolldown',
      version: '1.1.3',
      platform: 'win32',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.1.3.tgz',
      sha256: 'adc567f5a423c6e0db071272f7021b1a6d118368b7608eff22b8e61c4c7a6745',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-arm64': {
      name: 'rolldown',
      version: '1.1.3',
      platform: 'win32',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.1.3.tgz',
      sha256: '9d055f11eb04e60821013b30ce7d011491bcddf0169f59c7254499bb537b7da8',
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
