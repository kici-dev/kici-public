import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kiciDirNeedsManifest } from './agent-deps-preflight.js';

describe('kiciDirNeedsManifest', () => {
  let kici: string;
  beforeEach(async () => {
    kici = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kici-preflight-')), '.kici');
  });
  afterEach(async () => {
    await fs.rm(path.dirname(kici), { recursive: true, force: true });
  });

  it('is true for workflows with no .kici/package.json', async () => {
    await fs.mkdir(path.join(kici, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(kici, 'workflows', 'ci.ts'), 'export {};\n');
    // fails-when: the check looks for workflows anywhere but .kici/workflows/*.ts
    expect(await kiciDirNeedsManifest(kici)).toBe(true);
  });

  it('is false once .kici/package.json exists', async () => {
    await fs.mkdir(path.join(kici, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(kici, 'workflows', 'ci.ts'), 'export {};\n');
    await fs.writeFile(path.join(kici, 'package.json'), '{}');
    // breaks-if-wrong: a standalone or member .kici/ is never warned about
    expect(await kiciDirNeedsManifest(kici)).toBe(false);
  });

  it('is false with no .kici/ or no workflow files', async () => {
    expect(await kiciDirNeedsManifest(kici)).toBe(false);
    await fs.mkdir(path.join(kici, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(kici, 'workflows', 'notes.md'), '');
    expect(await kiciDirNeedsManifest(kici)).toBe(false);
  });
});
