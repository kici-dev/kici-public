import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, resolve } from './container-ts-loader-hook.ts';

describe('container-ts-loader-hook', () => {
  it('transforms a .ts file to runnable ESM with an inline sourcemap', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hook-'));
    const file = path.join(dir, 'wf.ts');
    await writeFile(
      file,
      'export const x: number = enumLike();\nfunction enumLike(): number { return 42; }\n',
    );
    const url = pathToFileURL(file).href;
    const nextLoad = () => {
      throw new Error('nextLoad should not be called for .ts');
    };
    const result = await load(url, { conditions: [], importAttributes: {} }, nextLoad as never);
    expect(result.format).toBe('module');
    expect(result.shortCircuit).toBe(true);
    expect(String(result.source)).toContain('const x = enumLike');
    expect(String(result.source)).toContain('sourceMappingURL=data:application/json;base64,');
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites a ./x.js specifier to ./x.ts when only the .ts sibling exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hook-'));
    await writeFile(path.join(dir, 'helper.ts'), 'export const h = 1;\n');
    const parentURL = pathToFileURL(path.join(dir, 'wf.ts')).href;
    let seen = '';
    const nextResolve = (spec: string) => {
      seen = spec;
      return { url: 'x' };
    };
    await resolve(
      './helper.js',
      { parentURL, conditions: [], importAttributes: {} },
      nextResolve as never,
    );
    expect(seen).toBe('./helper.ts');
    await rm(dir, { recursive: true, force: true });
  });

  it('passes non-.ts URLs straight through to nextLoad', async () => {
    let called = false;
    const nextLoad = () => {
      called = true;
      return { format: 'commonjs' as const };
    };
    await load('file:///pkg/index.js', { conditions: [], importAttributes: {} }, nextLoad as never);
    expect(called).toBe(true);
  });

  it('throws with the file path when the source has a transpile error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hook-'));
    const file = path.join(dir, 'bad.ts');
    // A genuinely un-transpilable construct: a decorator on a bare statement.
    await writeFile(file, 'const x: = ;\n');
    const url = pathToFileURL(file).href;
    const nextLoad = () => {
      throw new Error('nextLoad should not be called for .ts');
    };
    await expect(
      load(url, { conditions: [], importAttributes: {} }, nextLoad as never),
    ).rejects.toThrow(/typescript transpile failed for .*bad\.ts/);
    await rm(dir, { recursive: true, force: true });
  });
});
