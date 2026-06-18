#!/usr/bin/env node
// Shared rolldown TS->JS build script replacing SWC for all 7 non-dashboard packages.
// Usage: node ../../scripts/build-ts.mjs (run from any package directory)
import { build } from 'rolldown';
import { glob } from 'node:fs/promises';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const pkgVersion = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;

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

// Clean stale .js and .js.map files from dist/ before rebuilding.
// We preserve .d.ts files because tsc runs after rolldown and other packages
// may reference declarations from a parallel build (pnpm runs workspace builds
// concurrently when it doesn't detect workspace:* dependencies).
const distDir = path.join(cwd, 'dist');
function cleanJsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dist/ doesn't exist yet
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanJsFiles(full);
    } else if (
      entry.name.endsWith('.js') ||
      entry.name.endsWith('.js.map') ||
      entry.name.endsWith('.cjs') ||
      entry.name.endsWith('.cjs.map') ||
      entry.name.endsWith('.mjs') ||
      entry.name.endsWith('.mjs.map')
    ) {
      rmSync(full);
    }
  }
}
cleanJsFiles(distDir);

// Map src/foo/bar.ts -> entry name foo/bar (preserving directory structure)
const input = Object.fromEntries(
  allFiles.map((f) => [f.replace(/^src\//, '').replace(/\.ts$/, ''), path.join(cwd, f)]),
);

await build({
  input,
  platform: 'node',
  external: [/^[^./]/], // All bare imports external (library mode)
  treeshake: false,
  transform: {
    define: {
      KICI_VERSION: JSON.stringify(pkgVersion),
    },
  },
  output: {
    dir: path.join(cwd, 'dist'),
    format: 'es',
    sourcemap: true,
    entryFileNames: '[name].js',
  },
});

console.log(`Built ${allFiles.length} files to dist/`);
