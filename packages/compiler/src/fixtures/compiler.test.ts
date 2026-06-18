import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverFixtureFiles, compileFixtures, filterFixtures } from './compiler.js';
import type { CompiledFixture } from './compiler.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-fixture-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('discoverFixtureFiles', () => {
  it('returns empty array for missing directory', async () => {
    const result = await discoverFixtureFiles(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    const result = await discoverFixtureFiles(testsDir);
    expect(result).toEqual([]);
  });

  it('finds .ts files in directory', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    await fs.writeFile(path.join(testsDir, 'push.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(testsDir, 'pr.ts'), 'export const y = 2;');

    const result = await discoverFixtureFiles(testsDir);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('pr.ts');
    expect(result[1]).toContain('push.ts');
  });

  it('finds .ts files recursively', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    const subDir = path.join(testsDir, 'events');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(testsDir, 'push.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(subDir, 'pr.ts'), 'export const y = 2;');

    const result = await discoverFixtureFiles(testsDir);
    expect(result).toHaveLength(2);
    // Should be sorted
    expect(result[0]).toContain(path.join('events', 'pr.ts'));
    expect(result[1]).toContain('push.ts');
  });

  it('ignores non-.ts files', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    await fs.writeFile(path.join(testsDir, 'push.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(testsDir, 'readme.md'), '# test');
    await fs.writeFile(path.join(testsDir, 'config.json'), '{}');

    const result = await discoverFixtureFiles(testsDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('push.ts');
  });

  it('ignores .d.ts files', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    await fs.writeFile(path.join(testsDir, 'push.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(testsDir, 'types.d.ts'), 'export type X = string;');

    const result = await discoverFixtureFiles(testsDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('push.ts');
  });

  it('returns empty array when path is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(filePath, 'content');

    const result = await discoverFixtureFiles(filePath);
    expect(result).toEqual([]);
  });
});

describe('compileFixtures', () => {
  it('returns empty array for missing directory', async () => {
    const result = await compileFixtures(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('compiles and extracts Fixture exports', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });

    // Write a fixture file that uses the SDK
    await fs.writeFile(
      path.join(testsDir, 'push-tests.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';

export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});

export const pushDev = fixture('push-dev', {
  event: push({ branches: ['develop'] }),
  branch: 'develop',
});
`,
    );

    const result = await compileFixtures(testsDir);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['push-dev', 'push-main']);

    const pushMain = result.find((f) => f.id === 'push-main')!;
    expect(pushMain.sourceFile).toContain('push-tests.ts');
    expect(pushMain.fixture.id).toBe('push-main');

    const pushDev = result.find((f) => f.id === 'push-dev')!;
    const opts = pushDev.fixture.options as { branch?: string };
    expect(opts.branch).toBe('develop');
  });

  it('ignores non-Fixture exports', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });

    await fs.writeFile(
      path.join(testsDir, 'mixed.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';

// These should be ignored
export const helperFn = () => 'helper';
export const someString = 'not a fixture';
export const someNumber = 42;
export const someNull = null;

// This should be extracted
export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});
`,
    );

    const result = await compileFixtures(testsDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('push-main');
  });

  it('rejects duplicate fixture IDs', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });

    // Two files with the same fixture ID
    await fs.writeFile(
      path.join(testsDir, 'file1.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';
export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});
`,
    );

    await fs.writeFile(
      path.join(testsDir, 'file2.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';
export const pushMainDuplicate = fixture('push-main', {
  event: push({ branches: ['develop'] }),
});
`,
    );

    await expect(compileFixtures(testsDir)).rejects.toThrow('Duplicate fixture ID "push-main"');
  });

  it('resolves async factory fixtures', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });

    await fs.writeFile(
      path.join(testsDir, 'async.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';

export const asyncFixture = fixture('async-push', async () => ({
  event: push({ branches: ['main'] }),
  branch: 'async-branch',
}));
`,
    );

    const result = await compileFixtures(testsDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('async-push');
    // After compilation, the async factory should be resolved
    const opts = result[0].fixture.options as { branch?: string };
    expect(opts.branch).toBe('async-branch');
  });

  it('handles multiple files with different fixture IDs', async () => {
    const testsDir = path.join(tmpDir, 'tests');
    const subDir = path.join(testsDir, 'events');
    await fs.mkdir(subDir, { recursive: true });

    await fs.writeFile(
      path.join(testsDir, 'push.ts'),
      `
import { fixture, push } from '@kici-dev/sdk';
export const pushMain = fixture('push-main', { event: push({ branches: ['main'] }) });
`,
    );

    await fs.writeFile(
      path.join(subDir, 'pr.ts'),
      `
import { fixture, pr } from '@kici-dev/sdk';
export const prOpen = fixture('pr-open', { event: pr({ events: ['opened'] }) });
`,
    );

    const result = await compileFixtures(testsDir);
    expect(result).toHaveLength(2);
    const ids = result.map((f) => f.id).sort();
    expect(ids).toEqual(['pr-open', 'push-main']);
  });
});

describe('filterFixtures', () => {
  const fixtures: CompiledFixture[] = [
    {
      id: 'push-main',
      sourceFile: '/tmp/push.ts',
      fixture: { id: 'push-main', options: {} as any },
    },
    {
      id: 'push-dev',
      sourceFile: '/tmp/push.ts',
      fixture: { id: 'push-dev', options: {} as any },
    },
    {
      id: 'pr-open',
      sourceFile: '/tmp/pr.ts',
      fixture: { id: 'pr-open', options: {} as any },
    },
    {
      id: 'pr-close',
      sourceFile: '/tmp/pr.ts',
      fixture: { id: 'pr-close', options: {} as any },
    },
    {
      id: 'deploy-staging',
      sourceFile: '/tmp/deploy.ts',
      fixture: { id: 'deploy-staging', options: {} as any },
    },
  ];

  it('handles exact match', () => {
    const result = filterFixtures(fixtures, 'push-main');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('push-main');
  });

  it('handles push-* glob pattern', () => {
    const result = filterFixtures(fixtures, 'push-*');
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual(['push-dev', 'push-main']);
  });

  it('handles *-main glob pattern', () => {
    const result = filterFixtures(fixtures, '*-main');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('push-main');
  });

  it('handles pr-* glob pattern', () => {
    const result = filterFixtures(fixtures, 'pr-*');
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual(['pr-close', 'pr-open']);
  });

  it('returns empty array for no match', () => {
    const result = filterFixtures(fixtures, 'nonexistent-*');
    expect(result).toEqual([]);
  });

  it('returns sorted results for glob', () => {
    const result = filterFixtures(fixtures, '*-*');
    const ids = result.map((f) => f.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('glob with ? wildcard', () => {
    const result = filterFixtures(fixtures, 'pr-????');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('pr-open');
  });
});
