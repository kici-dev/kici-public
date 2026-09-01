import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { writeKiciGitignore } from './init.js';

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
