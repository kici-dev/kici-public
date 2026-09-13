/**
 * Publishes the `kici` wrapper package after @kici-dev/compiler is published.
 * Called automatically via compiler's postpublish hook.
 *
 * - Syncs version + dependency version from compiler
 * - Publishes kici to the same registry
 * - Restores the original package.json afterward
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerRestore, unregisterRestore } from '../../../hack/lib/restore-on-exit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const kiciPkgPath = resolve(__dirname, '..', 'package.json');
const compilerPkgPath = resolve(__dirname, '..', '..', 'compiler', 'package.json');

const compilerPkg = JSON.parse(readFileSync(compilerPkgPath, 'utf8'));
const original = readFileSync(kiciPkgPath, 'utf8');
const kiciPkg = JSON.parse(original);

const version = compilerPkg.version;
console.log(`[kici] Syncing wrapper to version ${version}`);

kiciPkg.version = version;

// Rewrite EVERY @kici-dev/* dependency (compiler, core, and any future
// internal dep) to the freshly-published version. A hardcoded single-dep
// rewrite would leave `@kici-dev/core: workspace:*` unrewritten in the
// tarball, which fails to install outside the workspace.
const syncedDeps = Object.keys(kiciPkg.dependencies ?? {}).filter((dep) =>
  dep.startsWith('@kici-dev/'),
);
for (const dep of syncedDeps) {
  kiciPkg.dependencies[dep] = version;
}
console.log(`[kici] Synced internal deps to ${version}: ${syncedDeps.join(', ')}`);

// Strip publishConfig.registry (production npmjs.org target) — pnpm prefers
// it over the --registry CLI flag and the npm_config_registry env var. For
// the local Verdaccio publish (postpublish hook of @kici-dev/compiler), we
// want pnpm to honor --registry / npm_config_registry instead.
if (kiciPkg.publishConfig?.registry) {
  delete kiciPkg.publishConfig.registry;
}

// Restore-on-exit safety net: if this process is killed (deploy timeout,
// Ctrl-C, parent abort) after the pin but before the `finally` restore, the
// kici manifest would be left pinned and break a downstream container build's
// --frozen-lockfile install. Register the original before pinning so an
// unexpected exit still rewrites it.
registerRestore(kiciPkgPath, original);
writeFileSync(kiciPkgPath, JSON.stringify(kiciPkg, null, 2) + '\n');

// Default to npmjs.org for prod publishes. publish-verdaccio.mjs sets
// KICI_PUBLISH_REGISTRY explicitly to point at the local Verdaccio for
// dev publishes. The npm_config_registry fallback is dropped because npm
// itself sets it inside lifecycle hooks to whatever the parent publish
// resolved — which is verdaccio.local when the parent's effective
// config is the repo's @kici-dev:registry= scope routing, sending the
// kici wrapper to the wrong registry on a prod release.
const registryUrl = process.env.KICI_PUBLISH_REGISTRY || 'https://registry.npmjs.org/';
const registryArgs = `--registry ${registryUrl}`;
// The npm publish for @kici-dev/compiler is launched with NPM_CONFIG_USERCONFIG
// pointing at infra/ci/.npmrc (registry auth token). npm normalises the env
// var to lowercase `npm_config_userconfig` inside lifecycle hooks; read that
// form so the inner npm publish keeps the auth-token userconfig instead of
// falling back to the operator's ~/.npmrc.
const userconfigArgs = process.env.npm_config_userconfig
  ? `--userconfig=${process.env.npm_config_userconfig}`
  : '';

try {
  let stdout = '';
  let stderr = '';
  try {
    // `npm publish` rather than `pnpm publish`: pnpm 11.0.6 mishandles
    // granular-access-token auth and 404s the PUT to npmjs.org even when
    // the token is valid. Direct npm publish works fine.
    const out = execSync(
      `npm publish --tag latest --access public --provenance=false ${registryArgs} ${userconfigArgs}`,
      {
        cwd: resolve(__dirname, '..'),
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    stdout = out ? out.toString() : '';
    process.stdout.write(stdout);
    console.log(`[kici] Published kici@${version}`);
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
    const combined = stdout + stderr;
    // E409 = version already exists in Verdaccio — not an error for the
    // re-build / re-publish loop the E2E suite drives. pnpm emits the E409
    // banner on stdout, not stderr, so check both streams.
    if (
      combined.includes('E409') ||
      combined.includes('EPUBLISHCONFLICT') ||
      combined.includes('this package is already present')
    ) {
      console.log(`[kici] Already published kici@${version}`);
    } else {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      throw e;
    }
  }
} finally {
  // Always restore the original package.json (in-band), and drop it from the
  // exit-safety-net set so a later flush doesn't redundantly rewrite it.
  writeFileSync(kiciPkgPath, original);
  unregisterRestore(kiciPkgPath);
}
