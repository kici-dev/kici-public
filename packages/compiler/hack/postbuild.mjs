#!/usr/bin/env -S npx zx
// There are a couple of assets we have to preserve in their initial state, like the workflow
// templates. This script copies those assets from the source directory to the build output
// directory after the build is complete.

import { initZx } from '@kici-dev/shared';
import { writeLlmContext } from './llm-context.mjs';

initZx();

const buildDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(__dirname, '..', 'src');
const repoRoot = path.join(__dirname, '..', '..', '..');

const assets = [
  {
    src: path.join(srcDir, 'templates', 'workflows'),
    dest: path.join(buildDir, 'templates', 'workflows'),
  },
  {
    src: path.join(srcDir, 'fixtures', 'defaults'),
    dest: path.join(buildDir, 'fixtures', 'defaults'),
  },
];

// When bundled, __dirname resolves to dist/, so copy ALL fixture JSON files there too.
// The bundled CLI uses readFileSync(join(__dirname, filename)) to load fixtures at runtime.
const fixtureDir = path.join(srcDir, 'fixtures', 'defaults');
const fixtureFiles = (await fs.readdir(fixtureDir)).filter((f) => f.endsWith('.json'));
for (const file of fixtureFiles) {
  const src = path.join(fixtureDir, file);
  const dest = path.join(buildDir, file);
  await fs.copy(src, dest);
}

// Also copy workflow templates to dist/workflows/ for bundled CLI
await fs.copy(path.join(srcDir, 'templates', 'workflows'), path.join(buildDir, 'workflows'));

for (const asset of assets) {
  await fs.mkdirp(path.dirname(asset.dest));
  await fs.copy(asset.src, asset.dest);
}

await writeLlmContext(repoRoot, path.join(buildDir, 'llm-context'));
