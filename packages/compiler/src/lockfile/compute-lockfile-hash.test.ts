import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLockfileHash } from './generator.js';

/**
 * `computeLockfileHash` keys the dep cache on the manager-appropriate lockfile,
 * prefixed with the manager name so two managers never collide on identical
 * lockfile bytes.
 */
describe('computeLockfileHash', () => {
  let root: string;
  let savedUserAgent: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-lockhash-'));
    await mkdir(join(root, '.kici'), { recursive: true });
    // The test runner sets npm_config_user_agent (pnpm), which would pollute
    // tier-3 detection; clear it so each case exercises the intended tier.
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
    // No .kici/package-lock.json — the old behavior returned null here.
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
    // The mirror of the yarn fallback: a repo whose root is npm (or carries no
    // pnpm signal) but whose .kici is pnpm. Without the .kici fallback the hash
    // was null, so the orchestrator never wrote a dep-cache key.
    await writeFile(
      join(root, '.kici', 'package.json'),
      JSON.stringify({ name: 'k', packageManager: 'pnpm@10.0.0' }),
    );
    await writeFile(join(root, '.kici', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    expect(computeLockfileHash(root)).toMatch(/^[0-9a-f]{64}$/);
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
