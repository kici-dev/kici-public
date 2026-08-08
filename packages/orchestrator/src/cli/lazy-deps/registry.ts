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
      version: '1.2.0',
      platform: 'linux',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.2.0.tgz',
      sha256: '0599c908dba1df8eb7b62917bd6956a9d13550bd06433ed9afa3cfffd5d717b0',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'linux-arm64': {
      name: 'rolldown',
      version: '1.2.0',
      platform: 'linux',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.2.0.tgz',
      sha256: 'f78d5a246cfbb02492466dfdafddafa0f5443c578cfcc08f6b0f4949ae7867da',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-x64': {
      name: 'rolldown',
      version: '1.2.0',
      platform: 'darwin',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.2.0.tgz',
      sha256: 'ba959c6f7b6f7e014a91d9cd4945a43ad25c6ee1be11cf168db5aa900accb323',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'darwin-arm64': {
      name: 'rolldown',
      version: '1.2.0',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.2.0.tgz',
      sha256: 'ff8570f11f374bf4d85f7f6149e4c61357468daf2eba036691e6dfc56bf5fed7',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-x64': {
      name: 'rolldown',
      version: '1.2.0',
      platform: 'win32',
      arch: 'x64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.2.0.tgz',
      sha256: '41e7e9db294390eb603c8596e118ca2d5190881199a022f193a6638d8da5dcd5',
      extractPath: 'package/',
      archiveType: 'tar.gz',
    },
    'win32-arm64': {
      name: 'rolldown',
      version: '1.2.0',
      platform: 'win32',
      arch: 'arm64',
      url: 'https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.2.0.tgz',
      sha256: 'e3a89e1f7eab70398a1f0bef55ef96f483a9ea19a61fc0b6f32ea06a7a91fb86',
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
