import { describe, it, expect } from 'vitest';
import { miseWindowsArch, resolveMiseWindowsAsset } from './windows-install.js';

describe('miseWindowsArch', () => {
  it('maps ARM64 env to arm64, else x64', () => {
    expect(miseWindowsArch('ARM64')).toBe('arm64');
    expect(miseWindowsArch('AMD64')).toBe('x64');
    expect(miseWindowsArch(undefined)).toBe('x64');
  });
});

describe('resolveMiseWindowsAsset', () => {
  const latest = {
    assets: [
      { name: 'mise-v2026.6.0-windows-x64.zip', browser_download_url: 'https://x/x64.zip' },
      { name: 'mise-v2026.6.0-windows-arm64.zip', browser_download_url: 'https://x/arm64.zip' },
      { name: 'mise-v2026.6.0-linux-x64.tar.gz', browser_download_url: 'https://x/lin' },
    ],
  };
  const pinned = {
    assets: [
      { name: 'mise-v2026.5.1-windows-x64.zip', browser_download_url: 'https://x/pinned-x64.zip' },
    ],
  };

  it('reads the latest release when unpinned', async () => {
    const urls: string[] = [];
    const fetchJson = async (url: string) => (urls.push(url), latest);
    expect(await resolveMiseWindowsAsset('x64', { fetchJson })).toBe('https://x/x64.zip');
    expect(await resolveMiseWindowsAsset('arm64', { fetchJson })).toBe('https://x/arm64.zip');
    expect(urls[0]).toBe('https://api.github.com/repos/jdx/mise/releases/latest');
  });

  it('reads releases/tags/v<version> when pinned', async () => {
    const urls: string[] = [];
    const fetchJson = async (url: string) => (urls.push(url), pinned);
    const url = await resolveMiseWindowsAsset('x64', { version: '2026.5.1', fetchJson });
    // fails-when: the pin is ignored and releases/latest is fetched
    expect(urls).toEqual(['https://api.github.com/repos/jdx/mise/releases/tags/v2026.5.1']);
    expect(url).toBe('https://x/pinned-x64.zip');
  });

  it('refuses a pinned release whose asset names another version', async () => {
    const fetchJson = async () => latest;
    // fails-when: a mislabeled release silently installs another version
    await expect(
      resolveMiseWindowsAsset('x64', { version: '2026.5.1', fetchJson }),
    ).rejects.toThrow(/no mise windows x64 asset in release v2026\.5\.1/);
  });

  it('throws when no matching asset exists', async () => {
    const fetchJson = async () => ({ assets: [] });
    await expect(resolveMiseWindowsAsset('x64', { fetchJson })).rejects.toThrow(/no mise windows/i);
  });
});
