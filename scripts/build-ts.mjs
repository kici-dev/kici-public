#!/usr/bin/env node
// Shared rolldown TS->JS build script replacing SWC for all 7 non-dashboard packages.
// Usage: node ../../scripts/build-ts.mjs (run from any package directory)
import { build } from 'rolldown';
import { glob } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  stageDir,
  publishStagedDist,
  pruneStaleArtifacts,
  assertPublished,
  pruneOrphanDeclarations,
} from './lib/atomic-dist.mjs';

const cwd = process.cwd();
const pkgVersion = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;

// Build-time git commit, mirrored from scripts/build-service.mjs. The
// KICI_BUILD_COMMIT env var is set by container/CI builds (git unavailable
// in containers) and by scripts/build-pipeline.ts (so the task cache hashes
// the same value the bundle carries); falls back to `git rev-parse` for a
// direct local invocation. Resolved lazily — only the packages that actually
// bake the constant pay for it.
function resolveBuildCommit() {
  const fromEnv = process.env.KICI_BUILD_COMMIT;
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown'; // git not available.
  }
}

// Collect all .ts files, filtering out test and declaration files
const allFiles = [];
for await (const f of glob('src/**/*.ts', { cwd })) {
  if (!f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
    allFiles.push(f);
  }
}

if (allFiles.length === 0) {
  console.error('No source files found in src/');
  process.exit(1);
}

// Bake KICI_BUILD_COMMIT only into packages that actually consume it. Baking it
// everywhere put a value nothing reads into core/shared/sdk/engine, which under
// task caching forces a cache miss on every commit for no benefit. Derived from
// the sources rather than an allowlist so it cannot drift, and mirrored by rule
// 1 of hack/check-turbo-config.ts, which fails the build config when a package
// that DOES consume the constant forgets to declare it in its turbo `env`.
const consumesBuildCommit = allFiles.some((f) =>
  readFileSync(path.join(cwd, f), 'utf8').includes('declare const KICI_BUILD_COMMIT'),
);

// Map src/foo/bar.ts -> entry name foo/bar (preserving directory structure)
const input = Object.fromEntries(
  allFiles.map((f) => [f.replace(/^src\//, '').replace(/\.ts$/, ''), path.join(cwd, f)]),
);

// Build into a staging directory and move each artifact onto its destination
// with an atomic rename, so a concurrent reader never sees a missing module.
const stage = stageDir(cwd);

await build({
  input,
  platform: 'node',
  external: [/^[^./]/], // All bare imports external (library mode)
  treeshake: false,
  transform: {
    define: {
      KICI_VERSION: JSON.stringify(pkgVersion),
      ...(consumesBuildCommit ? { KICI_BUILD_COMMIT: JSON.stringify(resolveBuildCommit()) } : {}),
    },
  },
  output: {
    dir: stage,
    format: 'es',
    sourcemap: true,
    entryFileNames: '[name].js',
  },
});

const published = publishStagedDist(cwd);
assertPublished(cwd, published);
pruneStaleArtifacts(cwd, published);
pruneOrphanDeclarations(cwd);

console.log(`Built ${allFiles.length} files to dist/`);
