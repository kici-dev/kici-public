import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as internal from './internal.js';
import * as root from './index.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * The runtime ABI the agent, compiler, and orchestrator drive on a workflow's
 * behalf. No workflow author calls any of it, so none of it belongs on the
 * compat-protected root barrel.
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

  // fails-when: a runtime-internal symbol is re-exported from the root barrel again
  it.each(RUNTIME_INTERNALS)('does not export %s from the root barrel', (name) => {
    expect(name in root).toBe(false);
  });

  // breaks-if-wrong: the agent's own import path must keep every setter
  it('keeps every output-map setter on the subpath', () => {
    for (const name of ['setStepOutputsMap', 'setJobOutputsMap', 'setStepRefMap']) {
      expect(typeof (internal as Record<string, unknown>)[name]).toBe('function');
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
