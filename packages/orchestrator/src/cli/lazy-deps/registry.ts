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
      version: '1.1.1',
      platform: 'linux',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.1.1.tgz',
      sha256: '55bf455e4d6c5df19636c40b434718891a574214bbf09a50e2e7b21b9f640d56',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'linux-arm64': {
      name: 'rolldown',
      version: '1.1.1',
      platform: 'linux',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.1.1.tgz',
      sha256: 'af458cfd2ce237a5161bdfdcef960e710c394b966537e1d1374840fb7fc78308',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-x64': {
      name: 'rolldown',
      version: '1.1.1',
      platform: 'darwin',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.1.1.tgz',
      sha256: '31bd12457aa41646dcee674d7fa73ec2c4625ef5d34d0ef6c6823cad811de3e2',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-arm64': {
      name: 'rolldown',
      version: '1.1.1',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.1.1.tgz',
      sha256: '8399e7a87640ffe485ba16289f6c3a7ab69b25d09b43e5896441372bcf6a02f9',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-x64': {
      name: 'rolldown',
      version: '1.1.1',
      platform: 'win32',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.1.1.tgz',
      sha256: '2b2c34d530db0e2cf15cdbe328822d5d385b19ee3b5aba55771587027b9afa17',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-arm64': {
      name: 'rolldown',
      version: '1.1.1',
      platform: 'win32',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.1.1.tgz',
      sha256: 'd7431cb75d0bed42dd8794b89c3d73ac7129a36465ac020519726f2a9dca1d7c',
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
