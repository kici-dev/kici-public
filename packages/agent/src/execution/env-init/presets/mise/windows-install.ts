/** mise Windows architecture slug used in release asset names. */
export type MiseWindowsArch = 'x64' | 'arm64';

interface GithubRelease {
  assets: { name: string; browser_download_url: string }[];
}

/** Map a Windows `PROCESSOR_ARCHITECTURE` value to mise's asset arch slug. */
export function miseWindowsArch(processorArch: string | undefined): MiseWindowsArch {
  return processorArch?.toUpperCase() === 'ARM64' ? 'arm64' : 'x64';
}

const RELEASES_API = 'https://api.github.com/repos/jdx/mise/releases';

/** GitHub API URL of the release to install: the tag `v<version>` when pinned, else the latest. */
function miseReleaseApiUrl(version?: string): string {
  return version === undefined ? `${RELEASES_API}/latest` : `${RELEASES_API}/tags/v${version}`;
}

/**
 * Resolve the download URL of the mise standalone Windows zip for `arch`, from
 * the pinned release (`version`, bare like `2026.5.1`) or the latest one. A
 * pinned asset must carry the pinned version in its name. `fetchJson` is
 * injected (defaults to a real fetch) so the lookup is testable without network.
 */
export async function resolveMiseWindowsAsset(
  arch: MiseWindowsArch,
  opts: { version?: string; fetchJson?: (url: string) => Promise<GithubRelease> } = {},
): Promise<string> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const release = await fetchJson(miseReleaseApiUrl(opts.version));
  const matches = (name: string): boolean =>
    opts.version === undefined
      ? name.endsWith(`-windows-${arch}.zip`)
      : name === `mise-v${opts.version}-windows-${arch}.zip`;
  const asset = release.assets.find((a) => matches(a.name));
  if (!asset) {
    const where = opts.version === undefined ? 'the latest release' : `release v${opts.version}`;
    throw new Error(`no mise windows ${arch} asset in ${where}`);
  }
  return asset.browser_download_url;
}

async function defaultFetchJson(url: string): Promise<GithubRelease> {
  const res = await fetch(url, { headers: { 'user-agent': 'kici-agent' } });
  if (!res.ok) throw new Error(`mise release lookup failed: ${res.status}`);
  return (await res.json()) as GithubRelease;
}
