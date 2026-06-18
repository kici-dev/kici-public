import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { miseCacheKey } from './cache-key.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mise-key-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('miseCacheKey', () => {
  it('derives a stable mise-<hash> key from mise.toml content', async () => {
    await writeFile(join(dir, 'mise.toml'), '[tools]\njq = "1.7.1"\n');
    const a = await miseCacheKey(dir);
    const b = await miseCacheKey(dir);
    expect(a).toBe(b);
    expect(a).toMatch(/^mise-[0-9a-f]{16}$/);
  });

  it('rotates the key when content changes', async () => {
    await writeFile(join(dir, 'mise.toml'), '[tools]\njq = "1.7.1"\n');
    const a = await miseCacheKey(dir);
    await writeFile(join(dir, 'mise.toml'), '[tools]\njq = "1.8.0"\n');
    const b = await miseCacheKey(dir);
    expect(a).not.toBe(b);
  });

  it('combines multiple config files in fixed order', async () => {
    await writeFile(join(dir, 'mise.toml'), 'a');
    await writeFile(join(dir, '.tool-versions'), 'node 20');
    const key = await miseCacheKey(dir);
    expect(key).toMatch(/^mise-[0-9a-f]{16}$/);
  });

  it('falls back to mise-noconfig when no config files exist', async () => {
    expect(await miseCacheKey(dir)).toBe('mise-noconfig');
  });
});
