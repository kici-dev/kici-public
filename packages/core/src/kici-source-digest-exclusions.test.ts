/**
 * The falsification suite for `.kici/.kiciignore`.
 *
 * Every case here reproduces the defect the file closes: the agent rewrites
 * `.kici/package-lock.json` (via `npm install`, deliberately not `npm ci`) and
 * `.kici/.npmrc` inside the very tree whose digest it must match, so the drift
 * gate rejected a run whose source never changed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashKiciSourceTree, loadKiciIgnoreRules } from './kici-source-digest.js';

let root: string;
let kiciDir: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(kiciDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-ignore-'));
  kiciDir = path.join(root, '.kici');
  await write('workflows/deploy.ts', "import { run } from '../lib/deploy.js';\n");
  await write('lib/deploy.ts', 'export const run = () => 1;\n');
  await write('package.json', '{"name":"x"}\n');
  await write('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  await write('.npmrc', 'registry=https://registry.npmjs.org/\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('criterion 1 — a run-rewritten tree hashes identically', () => {
  it('is unchanged when package-lock.json and .npmrc are rewritten, as a run rewrites them', async () => {
    const before = await hashKiciSourceTree(kiciDir);

    // Exactly what the agent does: `npm install` rewrites the lock file, and
    // `applyNpmRegistryConfig` appends its managed block to `.npmrc`.
    await write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"x"}}}\n');
    await write(
      '.npmrc',
      'registry=https://registry.npmjs.org/\n# kici-managed: applied for one npm install only\n//r/:_authToken=${T}\n',
    );

    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('is unchanged when node_modules/ and types/ appear', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write('node_modules/dep/index.js', 'module.exports = 1;\n');
    await write('types/secrets.d.ts', 'declare const s: string;\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('CONTROL — still moves when a workflow source file changes', async () => {
    // Proves the fix is not "hash nothing". Without this the suite above
    // would pass against a digest that always returns a constant.
    const before = await hashKiciSourceTree(kiciDir);
    await write('lib/deploy.ts', 'export const run = () => 2;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('CONTROL — still moves when a non-excluded file is added', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write('lib/extra.ts', 'export const x = 1;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });
});

describe('criterion 2 — replace semantics are real, and warn', () => {
  it('re-includes package-lock.json when .kiciignore omits it', async () => {
    await write('.kiciignore', 'node_modules/\n');

    const before = await hashKiciSourceTree(kiciDir);
    await write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"x"}}}\n');

    // The user asked for exactly one exclusion, so the lock file is hashed
    // again and the digest moves. Their choice — hence the warning below.
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('does NOT merge the defaults in when the file exists', async () => {
    await write('.kiciignore', 'node_modules/\n');
    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.source).toBe('file');
    expect(rules.patterns).toEqual(['node_modules/']);
  });

  it('warns, naming each omitted run-rewritten path and the instability', async () => {
    await write('.kiciignore', 'node_modules/\n');
    const rules = await loadKiciIgnoreRules(kiciDir);

    expect(rules.missingRunRewritten).toEqual(['.npmrc', 'package-lock.json']);
    expect(rules.warnings).toHaveLength(2);
    const joined = rules.warnings.join('\n');
    expect(joined).toContain('package-lock.json');
    expect(joined).toContain('.npmrc');
    expect(joined).toMatch(/rewrit/i);
    expect(joined).toContain('.kici/.kiciignore');
  });

  it('does not warn when the file covers every run-rewritten path', async () => {
    await write('.kiciignore', 'node_modules/\n.npmrc\npackage-lock.json\n');
    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.missingRunRewritten).toEqual([]);
    expect(rules.warnings).toEqual([]);
  });

  it('does not warn when the file is absent — the defaults cover everything', async () => {
    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.source).toBe('default');
    expect(rules.warnings).toEqual([]);
  });

  it('credits a run-rewritten path covered by a broader pattern', async () => {
    // `*` covers `.npmrc` and `package-lock.json`; the warning is about
    // instability, so a pattern that does exclude them must not warn.
    await write('.kiciignore', '*\n');
    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.missingRunRewritten).toEqual([]);
  });
});

describe('criterion 3 — kici.lock.json is forced, always', () => {
  it('stays excluded when .kiciignore omits it', async () => {
    await write('.kiciignore', 'node_modules/\n');

    await write('kici.lock.json', '{"contentHash":"aaa"}\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('kici.lock.json', '{"contentHash":"bbb"}\n');

    // Self-referential: the digest is written INTO this file. Hashing it
    // makes the hash non-computable, which is arithmetic, not policy.
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('stays excluded even when .kiciignore is empty', async () => {
    await write('.kiciignore', '# deliberately excludes nothing\n');
    await write('kici.lock.json', '{"contentHash":"aaa"}\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('kici.lock.json', '{"contentHash":"bbb"}\n');
    expect(await hashKiciSourceTree(kiciDir)).toBe(before);
  });

  it('is reported as forced by the rule loader', async () => {
    await write('.kiciignore', 'node_modules/\n');
    const rules = await loadKiciIgnoreRules(kiciDir);
    expect(rules.forced).toEqual(['kici.lock.json']);
  });
});

describe('.kiciignore is itself part of the identity', () => {
  it('moves the digest when its content changes', async () => {
    // Changing which files define a workflow's identity IS a change to that
    // identity. Excluding it would let someone silently change what a lock
    // file attests to.
    await write('.kiciignore', 'node_modules/\n.npmrc\npackage-lock.json\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('.kiciignore', 'node_modules/\n.npmrc\npackage-lock.json\npnpm-lock.yaml\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('moves the digest when it appears for the first time', async () => {
    const before = await hashKiciSourceTree(kiciDir);
    await write(
      '.kiciignore',
      'node_modules/\ntypes/\n.npmrc\npackage-lock.json\npnpm-lock.yaml\nkici.lock.json\n',
    );
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('cannot be excluded by a broad pattern that would otherwise cover it', async () => {
    // `*` covers every bare name. Forced inclusion has to outrank it, or the
    // simplest possible over-broad file silently drops the identity's scope
    // out of the identity.
    await write('.kiciignore', '*\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('.kiciignore', '*\n# edit\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });

  it('cannot be excluded by naming itself', async () => {
    await write('.kiciignore', '.kiciignore\nnode_modules/\n.npmrc\npackage-lock.json\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('.kiciignore', '.kiciignore\nnode_modules/\n.npmrc\npackage-lock.json\n# edit\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });
});

describe('nested .kiciignore files are not consulted', () => {
  it('reads only the one at the root of .kici/', async () => {
    // gitignore is per-directory; this is one declared list for one tree, so
    // a nested file is ordinary hashed source and nothing more.
    await write('lib/.kiciignore', 'deploy.ts\n');
    const before = await hashKiciSourceTree(kiciDir);
    await write('lib/deploy.ts', 'export const run = () => 2;\n');
    expect(await hashKiciSourceTree(kiciDir)).not.toBe(before);
  });
});
