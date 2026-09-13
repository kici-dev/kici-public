import { describe, it, expect } from 'vitest';
import { miseWindowsArch, resolveLatestMiseWindowsAsset } from './windows-install.js';

describe('miseWindowsArch', () => {
  it('maps ARM64 env to arm64, else x64', () => {
    expect(miseWindowsArch('ARM64')).toBe('arm64');
    expect(miseWindowsArch('AMD64')).toBe('x64');
    expect(miseWindowsArch(undefined)).toBe('x64');
  });
});

describe('resolveLatestMiseWindowsAsset', () => {
  const release = {
    assets: [
      { name: 'mise-v2026.6.0-windows-x64.zip', browser_download_url: 'https://x/x64.zip' },
      { name: 'mise-v2026.6.0-windows-arm64.zip', browser_download_url: 'https://x/arm64.zip' },
      { name: 'mise-v2026.6.0-linux-x64.tar.gz', browser_download_url: 'https://x/lin' },
    ],
  };

  it('returns the x64 asset url', async () => {
    const fetchJson = async () => release;
    expect(await resolveLatestMiseWindowsAsset('x64', fetchJson)).toBe('https://x/x64.zip');
  });

  it('returns the arm64 asset url', async () => {
    const fetchJson = async () => release;
    expect(await resolveLatestMiseWindowsAsset('arm64', fetchJson)).toBe('https://x/arm64.zip');
  });

  it('throws when no matching asset exists', async () => {
    const fetchJson = async () => ({ assets: [] });
    await expect(resolveLatestMiseWindowsAsset('x64', fetchJson)).rejects.toThrow(
      /no mise windows/i,
    );
  });
});
