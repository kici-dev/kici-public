import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLockfileHash } from './generator.js';

/** The dep-cache key is prefixed with the manager name so identical lockfile bytes never collide. */
describe('computeLockfileHash', () => {
  let root: string;
  let savedUserAgent: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-lockhash-'));
    await mkdir(join(root, '.kici'), { recursive: true });
    // The runner's npm_config_user_agent (pnpm) would pollute tier-3 detection.
    savedUserAgent = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
  });

  afterEach(async () => {
    if (savedUserAgent === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = savedUserAgent;
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when no lockfile is present', () => {
    expect(computeLockfileHash(root)).toBeNull();
  });

  it('hashes .kici/package-lock.json for an npm project', async () => {
    await writeFile(join(root, '.kici', 'package-lock.json'), '{"a":1}');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the repo-root pnpm-lock.yaml for a pnpm workspace', async () => {
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    // No .kici/package-lock.json, yet a hash is still produced.
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the repo-root yarn.lock for a yarn workspace', async () => {
    await writeFile(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to .kici/yarn.lock for a standalone yarn .kici project', async () => {
    // Root carries no yarn signal; .kici has its own packageManager field + lockfile.
    await writeFile(
      join(root, '.kici', 'package.json'),
      JSON.stringify({ name: 'k', packageManager: 'yarn@1.22.22' }),
    );
    await writeFile(join(root, '.kici', 'yarn.lock'), '# yarn lockfile v1\n');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to .kici/pnpm-lock.yaml for a standalone pnpm .kici project', async () => {
    // Mirror of the yarn fallback: an npm (or signal-less) root with a pnpm
    // .kici. Without the .kici fallback the hash is null and no dep-cache key is written.
    await writeFile(
      join(root, '.kici', 'package.json'),
      JSON.stringify({ name: 'k', packageManager: 'pnpm@10.0.0' }),
    );
    await writeFile(join(root, '.kici', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  // With no signal on disk, detection falls back to the ambient
  // `npm_config_user_agent`, so the INVOKING manager leaks in. Restricting the
  // search to that guess finds nothing and returns null, silently disabling the
  // dependency cache. The cases above clear the variable, so they cannot see this.
  it('hashes .kici/package-lock.json even when compiled under pnpm', async () => {
    process.env.npm_config_user_agent = 'pnpm/11.3.0 npm/? node/v24.15.0 linux x64';
    await writeFile(join(root, '.kici', 'package-lock.json'), '{"a":1}');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes .kici/package-lock.json even when compiled under yarn', async () => {
    process.env.npm_config_user_agent = 'yarn/1.22.22 npm/? node/v24.15.0 linux x64';
    await writeFile(join(root, '.kici', 'package-lock.json'), '{"a":1}');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  // The prefix names the manager whose lockfile matched, not the ambient guess,
  // or one repo would get two dep-cache keys and half the hit rate.
  it('is independent of which manager invoked the compiler', async () => {
    await writeFile(join(root, '.kici', 'package-lock.json'), '{"a":1}');

    delete process.env.npm_config_user_agent;
    const clean = computeLockfileHash(root);
    process.env.npm_config_user_agent = 'pnpm/11.3.0 npm/? node/v24.15.0 linux x64';
    const underPnpm = computeLockfileHash(root);

    expect(clean).not.toBeNull();
    expect(underPnpm).toBe(clean);
  });

  // Ordering, not restriction: a real root pnpm workspace still beats a stray
  // `.kici/package-lock.json`.
  it('prefers the detected manager when both lockfiles exist', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(join(root, '.kici', 'package-lock.json'), '{"a":1}');

    const both = computeLockfileHash(root);
    await rm(join(root, '.kici', 'package-lock.json'));
    const pnpmOnly = computeLockfileHash(root);

    expect(both).not.toBeNull();
    expect(both).toBe(pnpmOnly);
  });

  it('produces different hashes for classic vs berry on identical yarn.lock bytes', async () => {
    const lock = '# yarn lockfile\nfoo@^1:\n  version "1.0.0"\n';

    const classicRoot = await mkdtemp(join(tmpdir(), 'kici-lh-classic-'));
    await writeFile(
      join(classicRoot, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@1.22.22' }),
    );
    await writeFile(join(classicRoot, 'yarn.lock'), lock);

    const berryRoot = await mkdtemp(join(tmpdir(), 'kici-lh-berry-'));
    await writeFile(
      join(berryRoot, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@4.1.0' }),
    );
    await writeFile(join(berryRoot, 'yarn.lock'), lock);

    expect(computeLockfileHash(classicRoot)).not.toBe(computeLockfileHash(berryRoot));
    expect(computeLockfileHash(classicRoot)).not.toBeNull();

    await rm(classicRoot, { recursive: true, force: true });
    await rm(berryRoot, { recursive: true, force: true });
  });

  it('produces different hashes per manager for identical lockfile bytes', async () => {
    // Same bytes, different managers ⇒ different keys (manager prefix).
    await writeFile(join(root, '.kici', 'package-lock.json'), 'SAME');
    const npmHash = computeLockfileHash(root);

    await rm(join(root, '.kici', 'package-lock.json'));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'SAME');
    const pnpmHash = computeLockfileHash(root);

    expect(npmHash).not.toBeNull();
    expect(pnpmHash).not.toBeNull();
    expect(npmHash).not.toBe(pnpmHash);
  });
});
