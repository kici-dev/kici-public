import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// The container sandbox mounts this bundle as a single file into the customer
// job container, so every static import it loads at startup must resolve inside
// a bare Node image — i.e. be a `node:` built-in. `zx` + `@kici-dev/*` must be
// inlined, not left as bare imports. This test guards that load-time contract
// against a build-config regression that would silently ship a runner the job
// container cannot load. (Dynamic `require()`s inside inlined deps are guarded
// optional paths; the real end-to-end soak is the container-sandbox E2E.)
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
    // Rolldown emits every top-level import on its own line starting with
    // `import`. Match line-anchored `import ... from '<spec>'` and bare
    // side-effect `import '<spec>'` — this avoids matching `from '...'` that
    // appears inside embedded string literals of inlined dependencies.
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
