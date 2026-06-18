import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandInitDirectives } from './expand.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'expand-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('expandInitDirectives', () => {
  it('passes a generic directive through verbatim', async () => {
    const out = await expandInitDirectives([{ kind: 'generic', config: { run: 'echo hi' } }], {
      cloneRoot: dir,
      platform: 'linux',
    });
    expect(out).toEqual([{ run: 'echo hi' }]);
  });

  it('expands a mise preset directive', async () => {
    await writeFile(join(dir, 'mise.toml'), 'x');
    const out = await expandInitDirectives([{ kind: 'preset', name: 'mise', config: {} }], {
      cloneRoot: dir,
      platform: 'linux',
    });
    expect(out[0].run).toContain('mise install');
  });

  it('auto-detects mise when a marker is present', async () => {
    await writeFile(join(dir, '.tool-versions'), 'node 20');
    const out = await expandInitDirectives([{ kind: 'auto' }], {
      cloneRoot: dir,
      platform: 'linux',
    });
    expect(out).toHaveLength(1);
    expect(out[0].run).toContain('mise install');
  });

  it('auto with no markers is a no-op', async () => {
    const logs: string[] = [];
    const out = await expandInitDirectives([{ kind: 'auto' }], {
      cloneRoot: dir,
      platform: 'linux',
      log: (m) => logs.push(m),
    });
    expect(out).toEqual([]);
    expect(logs.join(' ')).toMatch(/no toolchain/i);
  });
});
