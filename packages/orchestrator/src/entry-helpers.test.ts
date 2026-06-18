import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canServeGenericProviderType,
  extractRepoIdentifier,
  diffProviderSources,
} from './entry-helpers.js';

describe('extractRepoIdentifier', () => {
  it('extracts owner/repo from GitHub URL', () => {
    expect(extractRepoIdentifier('https://github.com/myorg/myrepo.git')).toBe('myorg/myrepo');
  });

  it('extracts owner/repo from GitLab URL', () => {
    expect(extractRepoIdentifier('https://gitlab.com/ns/project.git')).toBe('ns/project');
  });

  it('returns unknown for unrecognized URLs', () => {
    expect(extractRepoIdentifier('https://example.com/repo')).toBe('unknown/unknown');
  });
});

describe('diffProviderSources', () => {
  it('detects added sources', () => {
    const old = [{ provider: 'github', routingKey: 'github:1' }];
    const fresh = [
      { provider: 'github', routingKey: 'github:1' },
      { provider: 'github', routingKey: 'github:2' },
    ];

    const diff = diffProviderSources(old, fresh);
    expect(diff.added).toEqual([{ provider: 'github', routingKey: 'github:2' }]);
    expect(diff.removed).toEqual([]);
  });

  it('detects removed sources', () => {
    const old = [
      { provider: 'github', routingKey: 'github:1' },
      { provider: 'github', routingKey: 'github:2' },
    ];
    const fresh = [{ provider: 'github', routingKey: 'github:1' }];

    const diff = diffProviderSources(old, fresh);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([{ provider: 'github', routingKey: 'github:2' }]);
  });

  it('detects both added and removed', () => {
    const old = [
      { provider: 'github', routingKey: 'github:1' },
      { provider: 'github', routingKey: 'github:2' },
    ];
    const fresh = [
      { provider: 'github', routingKey: 'github:2' },
      { provider: 'github', routingKey: 'github:3' },
    ];

    const diff = diffProviderSources(old, fresh);
    expect(diff.added).toEqual([{ provider: 'github', routingKey: 'github:3' }]);
    expect(diff.removed).toEqual([{ provider: 'github', routingKey: 'github:1' }]);
  });

  it('returns empty diff when identical', () => {
    const sources = [{ provider: 'github', routingKey: 'github:1' }];
    const diff = diffProviderSources(sources, sources);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('handles empty arrays', () => {
    const diff = diffProviderSources([], []);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe('canServeGenericProviderType', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'can-serve-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for `generic` regardless of git_config', () => {
    expect(canServeGenericProviderType('generic')).toBe(true);
    expect(canServeGenericProviderType('generic', null)).toBe(true);
  });

  it('returns true for `universal-git` regardless of git_config', () => {
    expect(canServeGenericProviderType('universal-git')).toBe(true);
    expect(canServeGenericProviderType('universal-git', null)).toBe(true);
  });

  it('returns false for `local` when git_config is missing / invalid', () => {
    expect(canServeGenericProviderType('local')).toBe(false);
    expect(canServeGenericProviderType('local', null)).toBe(false);
    expect(canServeGenericProviderType('local', JSON.stringify({ repoBasePath: 'relative' }))).toBe(
      false,
    );
  });

  it('returns false for `local` when the row repoBasePath does not exist', () => {
    expect(
      canServeGenericProviderType(
        'local',
        JSON.stringify({ repoBasePath: join(tmpDir, 'does-not-exist') }),
      ),
    ).toBe(false);
  });

  it('returns false for `local` when the row repoBasePath is a file (not a dir)', () => {
    const filePath = join(tmpDir, 'not-a-dir');
    writeFileSync(filePath, '');
    expect(canServeGenericProviderType('local', JSON.stringify({ repoBasePath: filePath }))).toBe(
      false,
    );
  });

  it('returns true for `local` when the row repoBasePath is a real directory', () => {
    expect(canServeGenericProviderType('local', JSON.stringify({ repoBasePath: tmpDir }))).toBe(
      true,
    );
    // Also accepts an already-parsed object (pg driver may hand back JSONB as an object).
    expect(canServeGenericProviderType('local', { repoBasePath: tmpDir })).toBe(true);
  });

  it('returns false for unknown provider_type values (fail closed)', () => {
    expect(canServeGenericProviderType('something-new', { repoBasePath: tmpDir })).toBe(false);
    expect(canServeGenericProviderType('')).toBe(false);
  });
});
