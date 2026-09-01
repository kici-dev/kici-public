import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canServeGenericProviderType,
  extractRepoIdentifier,
  diffProviderSources,
  isProductionEntry,
} from './entry-helpers.js';

describe('isProductionEntry', () => {
  const url = (p: string) => pathToFileURL(p).href;

  it('boots the native/full server.js entry', () => {
    const p = '/opt/kici/dist/server.js';
    expect(isProductionEntry(p, url(p))).toBe(true);
  });

  it('boots the cross-platform light bundle (kici-orchestrator.cjs)', () => {
    // Regression guard: the light bundle customers run on macOS / Windows / ARM
    // is named kici-orchestrator.cjs, not server.js. A guard keyed on
    // `endsWith('/server.js')` never fires here, so the bundle loads and exits 0
    // without starting the server.
    const p = '/opt/kici/lib/kici-orchestrator.cjs';
    expect(isProductionEntry(p, url(p))).toBe(true);
  });

  it('boots the ESM-wrapper light bundle (kici-orchestrator.mjs)', () => {
    const p = '/opt/kici/lib/kici-orchestrator.mjs';
    expect(isProductionEntry(p, url(p))).toBe(true);
  });

  it('boots the Windows light bundle (backslash path + `file://${__filename}` form)', () => {
    // Regression guard for the Windows-specific break: the bundle substitutes
    // import.meta.url as `file://${__filename}`, which on Windows is
    // `file://C:\...\kici-orchestrator.cjs` — never string-equal to
    // pathToFileURL(argv[1]).href (`file:///C:/.../kici-orchestrator.cjs`). The
    // orchestrator then loaded and exited 0 without starting the server.
    const argv = 'C:\\kici-stg\\service\\lib\\kici-orchestrator.cjs';
    const moduleUrl = 'file://C:\\kici-stg\\service\\lib\\kici-orchestrator.cjs';
    expect(isProductionEntry(argv, moduleUrl)).toBe(true);
  });

  it('boots the Windows native server.js entry', () => {
    const argv = 'C:\\opt\\kici\\dist\\server.js';
    const moduleUrl = 'file://C:\\opt\\kici\\dist\\server.js';
    expect(isProductionEntry(argv, moduleUrl)).toBe(true);
  });

  it('does NOT boot the Windows dev-only server-test.js entry', () => {
    const argv = 'C:\\opt\\kici\\dist\\server-test.js';
    const moduleUrl = 'file://C:\\opt\\kici\\dist\\server-test.js';
    expect(isProductionEntry(argv, moduleUrl)).toBe(false);
  });

  it('does NOT boot the dev-only server-test.js entry (avoids double boot)', () => {
    // server-test.js inlines server.ts but boots runServer itself with a fault
    // policy; the inlined guard must stay silent so only one orchestrator runs.
    const p = '/opt/kici/dist/server-test.js';
    expect(isProductionEntry(p, url(p))).toBe(false);
  });

  it('does NOT boot on bare import (module is not the process entry)', () => {
    // Imported by a test/other entry: argv[1] is the importer, not server.ts.
    expect(
      isProductionEntry(
        '/opt/kici/node_modules/vitest/dist/worker.js',
        url('/opt/kici/dist/server.js'),
      ),
    ).toBe(false);
  });

  it('does NOT boot when argv[1] is undefined', () => {
    expect(isProductionEntry(undefined, url('/opt/kici/dist/server.js'))).toBe(false);
  });
});

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
