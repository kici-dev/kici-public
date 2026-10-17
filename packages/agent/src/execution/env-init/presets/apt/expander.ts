import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { shQuote } from '@kici-dev/core';
import type { AptInitConfig, CacheSpec, GenericInitConfig } from '@kici-dev/sdk';
import { isAptPackageSpec } from '@kici-dev/sdk/internal';

/** Where the preset keeps downloaded `.deb` files when `cache` is on, as a cache path. */
export const APT_ARCHIVE_CACHE_PATH = '~/.cache/kici/apt/archives';

const DEFAULT_APT_TIMEOUT_MS = 600_000;
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_RUN =
  "[Console]::Error.WriteLine('kici init apt: the apt preset needs a Debian or Ubuntu runner; it does not run on Windows.'); exit 1";

/** Arguments to expand the apt preset into a concrete generic init config. */
export interface AptExpandArgs {
  cloneRoot: string;
  config: AptInitConfig;
  /** Host platform (defaults to process.platform). Injected for tests. */
  platform?: NodeJS.Platform;
  /** Reads `/etc/os-release` for the cache key. Injected for tests. */
  readOsRelease?: () => Promise<string>;
}

/** The validated package list. Throws on the first entry that is not a Debian package name. */
function aptPackages(config: AptInitConfig): string[] {
  if (!Array.isArray(config.packages) || config.packages.length === 0) {
    throw new Error('apt preset: packages must list at least one Debian package');
  }
  for (const spec of config.packages) {
    if (typeof spec !== 'string' || !isAptPackageSpec(spec)) {
      throw new Error(`apt preset: ${JSON.stringify(spec)} is not a Debian package name`);
    }
  }
  return config.packages;
}

/**
 * The `env` keys that apt-get receives. sudo resets the environment, so each
 * key is passed again by name. A key that is not a shell name cannot be, and
 * a `KICI_` key never reaches an init command.
 */
function forwardedEnvKeys(env: Record<string, string> | undefined): string[] {
  return Object.keys(env ?? {})
    .filter((key) => SHELL_NAME.test(key) && !key.toUpperCase().startsWith('KICI_'))
    .sort();
}

/**
 * The POSIX sh script that installs `packages` as root, or through `sudo -n`
 * as any other user. A user that is neither root nor allowed passwordless sudo
 * fails before apt-get runs, with a message naming the user; every sudo call
 * carries -n, so a password prompt can never wait.
 */
export function buildAptRun(opts: {
  packages: string[];
  envKeys: string[];
  cacheArchives: boolean;
}): string {
  const envArgs = ['DEBIAN_FRONTEND=noninteractive', ...opts.envKeys.map((k) => `${k}="$${k}"`)];
  const archives = opts.cacheArchives ? ' -o "Dir::Cache::Archives=$kici_apt_archives/"' : '';
  const aptGet = `$kici_apt_sudo env ${envArgs.join(' ')} apt-get${archives}`;
  return [
    'set -eu',
    'kici_apt_fail() { echo "kici init apt: $*" >&2; exit 1; }',
    'command -v apt-get >/dev/null 2>&1 || kici_apt_fail "apt-get was not found. The apt preset needs a Debian or Ubuntu runner; it does not run on macOS, Windows or other Linux distributions."',
    'kici_apt_user="$(id -un 2>/dev/null || id -u)"',
    'kici_apt_hint="Run the job as root, or in an image whose user may run sudo without a password."',
    'if [ "$(id -u)" = 0 ]; then',
    '  kici_apt_sudo=""',
    'elif ! command -v sudo >/dev/null 2>&1; then',
    '  kici_apt_fail "user $kici_apt_user is not root and sudo is not installed. $kici_apt_hint"',
    'elif ! sudo -n true 2>/dev/null; then',
    '  kici_apt_fail "user $kici_apt_user is not root and may not run sudo without a password. $kici_apt_hint"',
    'else',
    '  kici_apt_sudo="sudo -n"',
    'fi',
    ...(opts.cacheArchives
      ? [
          'kici_apt_archives="$HOME/.cache/kici/apt/archives"',
          'mkdir -p "$kici_apt_archives/partial"',
        ]
      : []),
    `${aptGet} update`,
    `${aptGet} install -y --no-install-recommends ${opts.packages.map(shQuote).join(' ')}`,
    // apt writes the archive as root; hand it back so the cache save can read it.
    ...(opts.cacheArchives
      ? ['$kici_apt_sudo chown -R "$(id -u):$(id -g)" "$kici_apt_archives"']
      : []),
  ].join('\n');
}

/**
 * Cache spec for the downloaded `.deb` files. The key names the distribution
 * release and the CPU architecture, so a cache never feeds another release's
 * packages to apt, plus a hash of the sorted package specs.
 */
export function aptCacheSpec(packages: string[], osRelease: string, arch: string): CacheSpec {
  const codename = /^VERSION_CODENAME="?([A-Za-z0-9._-]+)"?$/m.exec(osRelease)?.[1] ?? 'unknown';
  const prefix = `apt-${codename}-${arch}-`;
  const digest = createHash('sha256')
    .update([...packages].sort().join('\n'))
    .digest('hex');
  return {
    key: `${prefix}${digest.slice(0, 16)}`,
    paths: [APT_ARCHIVE_CACHE_PATH],
    restoreKeys: [prefix],
  };
}

async function readOsReleaseFile(): Promise<string> {
  return readFile('/etc/os-release', 'utf8').catch(() => '');
}

/** The apt preset expander: turns AptInitConfig into a generic init config. */
export const aptExpander = {
  async expand(args: AptExpandArgs): Promise<GenericInitConfig> {
    const packages = aptPackages(args.config);
    const timeout = args.config.timeout ?? DEFAULT_APT_TIMEOUT_MS;
    if ((args.platform ?? process.platform) === 'win32') {
      return { run: WINDOWS_RUN, shell: 'pwsh', timeout };
    }
    const cacheArchives = args.config.cache === true;
    const cfg: GenericInitConfig = {
      run: buildAptRun({ packages, envKeys: forwardedEnvKeys(args.config.env), cacheArchives }),
      shell: args.config.shell ?? 'sh',
      timeout,
    };
    if (cacheArchives) {
      const osRelease = await (args.readOsRelease ?? readOsReleaseFile)();
      cfg.cache = aptCacheSpec(packages, osRelease, process.arch);
    }
    if (args.config.env) cfg.env = args.config.env;
    return cfg;
  },
};
