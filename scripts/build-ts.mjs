#!/usr/bin/env node
// Shared rolldown TS->JS build script for the library packages.
// Usage: node ../../scripts/build-ts.mjs (run from any package directory)
import { build } from 'rolldown';
import { glob } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  stageDir,
  publishStagedDist,
  pruneStaleArtifacts,
  assertPublished,
  pruneOrphanDeclarations,
} from './lib/atomic-dist.mjs';

const cwd = process.cwd();
const pkgVersion = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;

// The build date a package's sources may read as KICI_BUILD_DATE: it tells two
// builds at the same version apart (the kici CLI's local plane identity). No
// build commit: it names a commit in the private repository, and the published
// packages carry every baked constant.
const buildDate = new Date().toISOString();

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
      KICI_BUILD_DATE: JSON.stringify(buildDate),
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
