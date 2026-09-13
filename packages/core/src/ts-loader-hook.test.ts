import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from './ts-loader-hook.js';

// The runtime `.ts` loader transforms via oxc-transform (Rust), never importing
// `typescript`, so it is independent of which compiler runs type-check / emit.
// This test proves the loader still strips modern TS-era syntax and yields the
// correct runtime value after the type-check/emit toolchain moved to TS7 tsgo.

const neverNextLoad = () => {
  throw new Error('nextLoad must not be called for a .ts URL');
};

describe('ts-loader-hook load()', () => {
  it('strips modern TS syntax via oxc and yields the runtime value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-ts-loader-'));
    try {
      // TS7-era syntax: `satisfies`, a `const` type parameter (on a function,
      // where it is valid), an `enum`, and a type-only export — all of which
      // must be erased to valid runtime JS.
      const tsSource = [
        'export const answer = (42 satisfies number);',
        'export type Id<K extends string> = K;',
        'export enum Color { Red = "red", Blue = "blue" }',
        'export const pick = <const T extends string>(v: T): T => v;',
        'export const chosen = pick("blue");',
      ].join('\n');
      const tsPath = join(dir, 'sample.ts');
      await writeFile(tsPath, tsSource, 'utf8');
      const tsUrl = pathToFileURL(tsPath).href;

      const result = await load(tsUrl, { importAttributes: {}, conditions: [] }, neverNextLoad);

      expect(result.format).toBe('module');
      expect(result.shortCircuit).toBe(true);
      const code = String(result.source);
      // Type-only constructs are erased; the value-level `enum` survives.
      expect(code).not.toContain('satisfies');
      expect(code).not.toContain('extends string');
      expect(code).toContain('Color');

      // Execute the transformed JS to prove the runtime values are correct.
      const jsPath = join(dir, 'sample.mjs');
      await writeFile(jsPath, code, 'utf8');
      const mod = await import(pathToFileURL(jsPath).href);
      expect(mod.answer).toBe(42);
      expect(mod.chosen).toBe('blue');
      expect(mod.Color.Red).toBe('red');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delegates non-.ts URLs to nextLoad untouched', async () => {
    const sentinel = { format: 'commonjs', source: 'delegated', shortCircuit: false };
    const result = await load(
      'file:///some/module.js',
      { importAttributes: {}, conditions: [] },
      () => sentinel,
    );
    expect(result).toBe(sentinel);
  });
});
