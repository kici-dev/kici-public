import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as internal from './internal.js';
import * as root from './index.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * The runtime ABI the agent, compiler, and orchestrator drive on a workflow's
 * behalf. No workflow author calls any of it, so none of it belongs on a
 * compat-protected barrel — but each one stays there, `@deprecated`, until the
 * v1.0.0 removal sweep.
 *
 * Pinning the set is what stops the root barrel growing a new internal: adding
 * one to `index.ts` without adding it here fails, and the failure names the
 * subpath it should have gone to instead.
 */
const RUNTIME_INTERNALS = [
  'applyIncludeExclude',
  'buildKiciApi',
  'buildNeedsContext',
  'createFilterContext',
  'createRuleContext',
  'createStepSecrets',
  'evaluateRules',
  'expandMatrix',
  'flattenStepInputs',
  'normalizeApproval',
  'normalizeCacheSpecs',
  'setJobOutputsMap',
  'setStepOutputsMap',
  'setStepRefMap',
];

describe('@kici-dev/sdk/internal', () => {
  it('exports exactly the runtime-internal set', () => {
    expect(Object.keys(internal).sort()).toEqual([...RUNTIME_INTERNALS].sort());
  });

  it('exports every symbol as a callable', () => {
    for (const name of RUNTIME_INTERNALS) {
      expect(typeof (internal as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('keeps each symbol on the root barrel, so an older customer tree still resolves', () => {
    // The agent resolves the customer's OWN SDK copy at run time. Removing a
    // symbol from the root before v1.0.0 breaks every tree that has not bumped.
    for (const name of RUNTIME_INTERNALS) {
      expect((root as Record<string, unknown>)[name]).toBe(
        (internal as Record<string, unknown>)[name],
      );
    }
  });

  it('marks every root re-export @deprecated', () => {
    const barrel = readFileSync(path.join(SRC, 'index.ts'), 'utf8').split('\n');
    for (const name of RUNTIME_INTERNALS) {
      const line = barrel.findIndex(
        (l) => /^export \{/.test(l) && new RegExp(`\\b${name}\\b`).test(l),
      );
      expect(line, `${name} is not re-exported on its own line in index.ts`).toBeGreaterThan(0);
      expect(barrel[line - 1], `${name} is missing its @deprecated marker`).toContain(
        '@deprecated',
      );
    }
  });

  it('declares the ./internal subpath in package.json exports', () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./internal']).toEqual({
      types: './dist/internal.d.ts',
      import: './dist/internal.js',
      default: './dist/internal.js',
    });
  });
});
