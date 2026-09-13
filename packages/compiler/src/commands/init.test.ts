import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  hashKiciSourceTree,
  loadKiciIgnoreRules,
} from '@kici-dev/core/kici-source-digest';

import { writeKiciGitignore, writeKiciIgnore } from './init.js';

describe('writeKiciIgnore', () => {
  let tempDir: string;
  let kiciDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-init-kiciignore-'));
    kiciDir = path.join(tempDir, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds the full default set, so a fresh repo is complete by construction', async () => {
    await writeKiciIgnore(kiciDir);

    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.source).toBe('file');
    expect(rules.patterns).toEqual([...KICI_DIGEST_DEFAULT_EXCLUSIONS]);
  });

  it('seeds a file that emits no compile warning', async () => {
    // The whole point of seeding: a new repo must never meet the footgun the
    // warning exists to explain.
    await writeKiciIgnore(kiciDir);
    expect((await loadKiciIgnoreRules(kiciDir)).warnings).toEqual([]);
  });

  it('explains replace semantics and disambiguates the repo-root .kiciignore', async () => {
    await writeKiciIgnore(kiciDir);
    const content = await fs.readFile(path.join(kiciDir, '.kiciignore'), 'utf-8');
    expect(content).toContain('replaces the built-in defaults');
    expect(content).toContain('repo-root .kiciignore');
  });

  it('never overwrites an existing .kici/.kiciignore', async () => {
    const target = path.join(kiciDir, '.kiciignore');
    const existing = 'node_modules/\n';
    await fs.writeFile(target, existing, 'utf-8');

    await writeKiciIgnore(kiciDir);

    expect(await fs.readFile(target, 'utf-8')).toBe(existing);
  });

  it('excludes a symlinked node_modules, so a scaffolded repo hashes as the agent does', async () => {
    // The scaffolded file REPLACES the defaults, so a fix that only edited the
    // default exclusion set would leave every `kici init` repo broken. This
    // asserts through the file this command actually writes, not through a
    // restatement of it.
    await writeKiciIgnore(kiciDir);
    await fs.writeFile(path.join(kiciDir, 'workflow.ts'), 'export const x = 1;\n', 'utf-8');

    const agentDir = path.join(tempDir, 'agent', '.kici');
    await fs.mkdir(path.join(agentDir, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(agentDir, 'node_modules', 'dep', 'index.js'), '1\n', 'utf-8');
    await fs.copyFile(path.join(kiciDir, '.kiciignore'), path.join(agentDir, '.kiciignore'));
    await fs.writeFile(path.join(agentDir, 'workflow.ts'), 'export const x = 1;\n', 'utf-8');

    // The producer borrows a sibling's installed toolchain through a link; the
    // agent's dependency install writes a real directory.
    await fs.mkdir(path.join(tempDir, 'shared'), { recursive: true });
    await fs.symlink('../shared', path.join(kiciDir, 'node_modules'));

    expect(await hashKiciSourceTree(kiciDir)).toBe(await hashKiciSourceTree(agentDir));
  });
});

describe('writeKiciGitignore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-init-gitignore-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('scaffolds .kici/.gitignore ignoring types/ but NOT kici.lock.json', async () => {
    const kiciDir = path.join(tempDir, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });

    await writeKiciGitignore(kiciDir);

    const content = await fs.readFile(path.join(kiciDir, '.gitignore'), 'utf-8');
    // The generated type declarations are ignored...
    expect(content).toContain('types/');
    // ...but the lock file is source (the orchestrator fetches it from the repo),
    // so it must never be ignored.
    expect(content).not.toContain('kici.lock.json');
  });

  it('never overwrites an existing .kici/.gitignore', async () => {
    const kiciDir = path.join(tempDir, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });
    const gitignorePath = path.join(kiciDir, '.gitignore');
    const existing = 'types/\ncustom-entry/\n';
    await fs.writeFile(gitignorePath, existing, 'utf-8');

    await writeKiciGitignore(kiciDir);

    // A hand-edited file is left untouched.
    expect(await fs.readFile(gitignorePath, 'utf-8')).toBe(existing);
  });
});
