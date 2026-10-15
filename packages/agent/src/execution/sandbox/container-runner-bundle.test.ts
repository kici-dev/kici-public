import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// The container sandbox mounts this bundle as a single file into the customer
// job container, so every static import must resolve in a bare Node image — a
// `node:` built-in; `zx` + `@kici-dev/*` must be inlined. Guards against a
// build-config regression shipping a runner the container cannot load.
// (Dynamic `require()`s inside inlined deps are guarded optional paths; a real
// container run needs a container runtime, which this file does not start.)
const bundlePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../dist/workflow-runner-bundle.js',
);

const isBuiltin = (id: string): boolean =>
  id.startsWith('node:') || builtinModules.includes(id.replace(/^node:/, ''));

describe('workflow-runner bundle is self-contained', () => {
  it('every static top-level import is a node builtin (zx + @kici-dev/* inlined)', () => {
    expect(existsSync(bundlePath), 'run `pnpm build` in packages/agent first').toBe(true);
    const src = readFileSync(bundlePath, 'utf8');
    // Rolldown emits each top-level import on its own line; line-anchoring
    // avoids matching `from '...'` inside inlined dependencies' string literals.
    const specifiers: string[] = [];
    for (const line of src.split('\n')) {
      const m =
        /^import\b[^'"]*?from\s*['"]([^'"]+)['"]/.exec(line) ??
        /^import\s*['"]([^'"]+)['"]/.exec(line);
      if (m) specifiers.push(m[1]);
    }
    expect(specifiers.length, 'expected the bundle to have static imports').toBeGreaterThan(0);
    const nonBuiltin = specifiers.filter((id) => !isBuiltin(id));
    expect(
      nonBuiltin,
      `unexpected external static imports: ${[...new Set(nonBuiltin)].join(', ')}`,
    ).toEqual([]);
  });
});
