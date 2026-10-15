import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from './ts-loader-hook.js';

// The loader uses oxc-transform and never imports `typescript`, so it is
// independent of the type-check / emit compiler (the TS7 native `tsc`). This
// proves it still strips modern TS syntax and yields correct runtime values.

const neverNextLoad = () => {
  throw new Error('nextLoad must not be called for a .ts URL');
};

describe('ts-loader-hook load()', () => {
  it('strips modern TS syntax via oxc and yields the runtime value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-ts-loader-'));
    try {
      // TS7-era syntax that must become valid runtime JS (a `const` type
      // parameter is valid only on a function).
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
