import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { miseExpander } from './expander.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mise-exp-'));
  await writeFile(join(dir, 'mise.toml'), '[tools]\njq = "1.7.1"\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('miseExpander (linux)', () => {
  it('produces a bash generic config with a content-derived cache', async () => {
    const cfg = await miseExpander.expand({ cloneRoot: dir, config: {}, platform: 'linux' });
    expect(cfg.shell).toBe('bash');
    expect(cfg.run).toContain('curl -fsSL https://mise.run | sh');
    expect(cfg.cache).toBeTruthy();
    expect(cfg.cache!.key).toMatch(/^mise-[0-9a-f]{16}$/);
    expect(cfg.cache!.paths).toEqual(['~/.local/share/mise']);
    expect(cfg.cache!.restoreKeys).toEqual(['mise-']);
    expect(cfg.timeout).toBe(600_000);
  });

  it('honors cache:false (no cache)', async () => {
    const cfg = await miseExpander.expand({
      cloneRoot: dir,
      config: { cache: false },
      platform: 'linux',
    });
    expect(cfg.cache).toBeUndefined();
  });

  it('honors a CacheSpec override + timeout/env/shell overrides', async () => {
    const cfg = await miseExpander.expand({
      cloneRoot: dir,
      config: { cache: { key: 'k', paths: ['p'] }, timeout: 5, env: { A: '1' }, shell: 'zsh' },
      platform: 'linux',
    });
    expect(cfg.cache).toEqual({ key: 'k', paths: ['p'] });
    expect(cfg.timeout).toBe(5);
    expect(cfg.env).toEqual({ A: '1' });
    expect(cfg.shell).toBe('zsh');
  });
});

describe('miseExpander (win32)', () => {
  it('produces a pwsh config with the asset url substituted + Windows cache path', async () => {
    const cfg = await miseExpander.expand({
      cloneRoot: dir,
      config: {},
      platform: 'win32',
      resolveWindowsAsset: async () => 'https://example/mise-windows-x64.zip',
    });
    expect(cfg.shell).toBe('pwsh');
    expect(cfg.run).toContain('https://example/mise-windows-x64.zip');
    expect(cfg.run).not.toContain('<ASSET_URL>');
    expect(cfg.cache!.paths).toEqual(['~/AppData/Local/mise']);
  });
});
