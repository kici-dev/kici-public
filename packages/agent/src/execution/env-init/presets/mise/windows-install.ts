/** mise Windows architecture slug used in release asset names. */
export type MiseWindowsArch = 'x64' | 'arm64';

interface GithubRelease {
  assets: { name: string; browser_download_url: string }[];
}

/** Map a Windows `PROCESSOR_ARCHITECTURE` value to mise's asset arch slug. */
export function miseWindowsArch(processorArch: string | undefined): MiseWindowsArch {
  return processorArch?.toUpperCase() === 'ARM64' ? 'arm64' : 'x64';
}

const LATEST_RELEASE_URL = 'https://api.github.com/repos/jdx/mise/releases/latest';

/**
 * Resolve the download URL of the latest mise standalone Windows zip for `arch`.
 * `fetchJson` is injected (defaults to a real fetch) so the resolution is
 * unit-testable without network.
 */
export async function resolveLatestMiseWindowsAsset(
  arch: MiseWindowsArch,
  fetchJson: (url: string) => Promise<GithubRelease> = defaultFetchJson,
): Promise<string> {
  const release = await fetchJson(LATEST_RELEASE_URL);
  const suffix = `-windows-${arch}.zip`;
  const asset = release.assets.find((a) => a.name.endsWith(suffix));
  if (!asset) {
    throw new Error(`no mise windows ${arch} asset in latest release`);
  }
  return asset.browser_download_url;
}

async function defaultFetchJson(url: string): Promise<GithubRelease> {
  const res = await fetch(url, { headers: { 'user-agent': 'kici-agent' } });
  if (!res.ok) throw new Error(`mise release lookup failed: ${res.status}`);
  return (await res.json()) as GithubRelease;
}
