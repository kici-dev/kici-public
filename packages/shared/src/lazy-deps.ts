/**
 * The registry of the binaries `kici-admin` downloads on first use (lazy dependencies), one
 * entry per platform/arch variant, and the mirror layout they are served under.
 *
 * Plain data with no Node import, so any package can read it: `kici-admin` downloads from it,
 * the Platform image fetches every variant at build time and serves it from its own files, and
 * the freshness audit reads the pins.
 */

export interface LazyDep {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  url: string;
  /** Of the downloaded archive. */
  sha256: string;
  /** Relative path inside the archive to the binary/directory. */
  extractPath: string;
  archiveType: 'tar.gz' | 'zip' | 'binary';
}

type VariantKey = `${NodeJS.Platform}-${string}`;

/** Keyed by name, then platform-arch. */
export const LAZY_DEPS: Record<string, Record<VariantKey, LazyDep>> = {
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
 * The setting that names a mirror of the lazy dependencies: an `http(s)://` or `file://` base
 * that holds each archive at {@link lazyDepMirrorPath}.
 */
export const LAZY_DEPS_MIRROR_ENV = 'KICI_LAZY_DEPS_MIRROR';

/**
 * Platform and arch default to the running process.
 * @throws If the dependency or variant is not in the registry.
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

/** Every variant of every lazy dependency. */
export function allLazyDeps(): LazyDep[] {
  return Object.values(LAZY_DEPS).flatMap((variants) => Object.values(variants));
}

/** The last path segment of `dep.url`: the archive's file name. */
export function lazyDepFileName(dep: LazyDep): string {
  const segments = new URL(dep.url).pathname.split('/');
  return decodeURIComponent(segments[segments.length - 1]!);
}

/** Where a mirror holds `dep`: `<name>/<version>/<platform>-<arch>/<file name>`. */
export function lazyDepMirrorPath(dep: LazyDep): string {
  return `${dep.name}/${dep.version}/${dep.platform}-${dep.arch}/${lazyDepFileName(dep)}`;
}

/**
 * The registry entry a mirror path names, or `undefined` when no entry has exactly that name,
 * version, variant and file name. A reader that serves mirror paths serves only these.
 */
export function lazyDepAtMirrorPath(
  name: string,
  version: string,
  variant: string,
  file: string,
): LazyDep | undefined {
  // Own keys only, so `__proto__` or `constructor` never reads an inherited value.
  const variants = Object.hasOwn(LAZY_DEPS, name) ? LAZY_DEPS[name] : undefined;
  const dep =
    variants && Object.hasOwn(variants, variant) ? variants[variant as VariantKey] : undefined;
  return dep && dep.version === version && lazyDepFileName(dep) === file ? dep : undefined;
}
