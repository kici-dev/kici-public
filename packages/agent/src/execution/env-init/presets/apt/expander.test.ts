import { describe, it, expect } from 'vitest';
import { aptExpander, aptCacheSpec, buildAptRun, APT_ARCHIVE_CACHE_PATH } from './expander.js';

const TRIXIE = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\n';

describe('aptExpander', () => {
  it('builds an sh install with quoted packages, the default timeout and no cache', async () => {
    const cfg = await aptExpander.expand({
      cloneRoot: '/w',
      config: { packages: ['make', 'g++'] },
      platform: 'linux',
    });
    expect(cfg.shell).toBe('sh');
    expect(cfg.timeout).toBe(600_000);
    expect(cfg.cache).toBeUndefined();
    expect(cfg.run).toContain("install -y --no-install-recommends 'make' 'g++'");
  });

  it('caches the archive dir under a key from the distribution, arch and packages', async () => {
    const cfg = await aptExpander.expand({
      cloneRoot: '/w',
      config: { packages: ['tree', 'make'], cache: true },
      platform: 'linux',
      readOsRelease: async () => TRIXIE,
    });
    expect(cfg.cache?.paths).toEqual([APT_ARCHIVE_CACHE_PATH]);
    expect(cfg.cache?.key).toMatch(new RegExp(`^apt-trixie-${process.arch}-[0-9a-f]{16}$`));
    expect(cfg.cache?.restoreKeys).toEqual([`apt-trixie-${process.arch}-`]);
    expect(cfg.run).toContain('Dir::Cache::Archives=$kici_apt_archives/');
  });

  it('keys the cache on the package set, not its order', () => {
    // fails-when: reordering the same packages misses the cache, or adding one hits it
    const a = aptCacheSpec(['make', 'tree'], TRIXIE, 'x64').key;
    expect(aptCacheSpec(['tree', 'make'], TRIXIE, 'x64').key).toBe(a);
    expect(aptCacheSpec(['tree', 'make', 'jq'], TRIXIE, 'x64').key).not.toBe(a);
    expect(
      aptCacheSpec(['make', 'tree'], TRIXIE.replaceAll('trixie', 'noble'), 'x64').key,
    ).not.toBe(a);
  });

  it('fails the init with a reason on Windows', async () => {
    const cfg = await aptExpander.expand({
      cloneRoot: 'C:\\w',
      config: { packages: ['make'] },
      platform: 'win32',
    });
    expect(cfg.shell).toBe('pwsh');
    expect(cfg.run).toContain('does not run on Windows');
    expect(cfg.run).toContain('exit 1');
  });

  it('refuses a package name the SDK would have refused', async () => {
    // fails-when: a cast around job() reaches apt-get with a shell suffix
    await expect(
      aptExpander.expand({
        cloneRoot: '/w',
        config: { packages: ['make; id'] },
        platform: 'linux',
      }),
    ).rejects.toThrow(/apt preset: "make; id" is not a Debian package name/);
  });

  it('forwards env keys through sudo by name', () => {
    const run = buildAptRun({ packages: ['make'], envKeys: ['http_proxy'], cacheArchives: false });
    expect(run).toContain('env DEBIAN_FRONTEND=noninteractive http_proxy="$http_proxy" apt-get');
  });

  it('passes env through and keeps overrides, never forwarding KICI_ keys or non-identifiers', async () => {
    const cfg = await aptExpander.expand({
      cloneRoot: '/w',
      config: {
        packages: ['make'],
        env: { http_proxy: 'p', KICI_X: 'x', 'BAD-KEY': 'y' },
        shell: 'bash',
        timeout: 5,
      },
      platform: 'linux',
    });
    expect(cfg.env).toEqual({ http_proxy: 'p', KICI_X: 'x', 'BAD-KEY': 'y' });
    expect(cfg.shell).toBe('bash');
    expect(cfg.timeout).toBe(5);
    expect(cfg.run).toContain('http_proxy="$http_proxy"');
    expect(cfg.run).not.toContain('KICI_X');
    expect(cfg.run).not.toContain('BAD-KEY');
  });
});
