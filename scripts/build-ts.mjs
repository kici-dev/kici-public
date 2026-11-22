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
  isTestOnlySource,
} from './lib/atomic-dist.mjs';
import { generatedChunksImportingNode, resolveLibraryPlatform } from './lib/build-platform.mjs';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
const pkgVersion = pkg.version;
// `build.platform: "neutral"` for a package the dashboard bundles (lib/build-platform.mjs).
const platform = resolveLibraryPlatform(pkg);

// The build date a package's sources may read as KICI_BUILD_DATE: it tells two
// builds at the same version apart (the kici CLI's local plane identity). No
// build commit: it names a commit in the private repository, and the published
// packages carry every baked constant.
const buildDate = new Date().toISOString();

const allFiles = [];
for await (const f of glob('src/**/*.ts', { cwd })) {
  if (!f.endsWith('.d.ts') && !isTestOnlySource(f)) {
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

const result = await build({
  input,
  platform,
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

if (platform === 'neutral') {
  const offending = generatedChunksImportingNode(result.output);
  if (offending.length > 0) {
    throw new Error(
      `a browser-bundled package must not ship a generated chunk importing node:*: ${offending.join(', ')}`,
    );
  }
}

const published = publishStagedDist(cwd);
assertPublished(cwd, published);
pruneStaleArtifacts(cwd, published);
pruneOrphanDeclarations(cwd);

console.log(`Built ${allFiles.length} files to dist/`);
