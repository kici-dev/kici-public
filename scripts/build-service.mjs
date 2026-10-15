#!/usr/bin/env node
/**
 * Bundle a service package into single-file entry points with internal code
 * inlined (build-ts.mjs, by contrast, transpiles file by file).
 *
 * Usage: node ../../scripts/build-service.mjs (from a service package directory)
 *
 * `build.entries` in package.json maps output filenames to sources:
 *
 *   "build": { "entries": { "server.js": "src/server.ts", "worker.js": "src/worker.ts" } }
 *
 * Bare imports (not starting with . or /), `@kici-dev/*` included, stay
 * external: they resolve from node_modules or ship as separate packages.
 */

import { build, RolldownMagicString } from 'rolldown';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  stageDir,
  publishStagedDist,
  pruneStaleArtifacts,
  assertPublished,
  pruneOrphanDeclarations,
} from './lib/atomic-dist.mjs';
import { builtinModules } from 'node:module';

/**
 * Entries delivered to the customer job container as single files, so they are
 * self-contained: `zx` and `@kici-dev/*` (pure JS) are inlined and only `node:`
 * built-ins stay external. Other entries run where node_modules exists.
 */
const BUNDLE_ENTRIES = new Set(['workflow-runner-bundle.js', 'container-ts-loader-hook.js']);
const nodeBuiltinExternal = [
  /^node:/,
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

/**
 * Whether the bundled code references `__filename` / `__dirname`.
 *
 * Assumes minification is OFF: a minifier could rename the globals, so the
 * regex would miss them and silently drop the shim (runtime `__dirname is not
 * defined`, no build error). Revisit if minification is enabled.
 */
export const usesCjsGlobals = (code) => /\b__(filename|dirname)\b/.test(code);

// The repo root is the nearest directory with pnpm-workspace.yaml: `private:
// true` is no marker, since service packages are private too.
export function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    try {
      statSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      // Not here.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd's grandparent (packages/<name>/ -> repo root).
  return path.resolve(start, '..', '..');
}

/**
 * A workspace dependency's version and `dist/index.js` sha256, for drift
 * diagnostics. Either is `'unknown'` when unreadable (peer not yet built); a
 * self-build returns both `'unknown'` rather than read its own stale dist.
 *
 * pnpm's build topology (shared -> engine -> sdk -> everything else) builds the
 * peers before agent / orchestrator / platform are bundled. Pure, so it is
 * directly testable; main() is the only caller resolving `repoRoot` and
 * `selfName` from the process environment.
 */
export function readDepMeta(depName, opts = {}) {
  const root = opts.repoRoot ?? findRepoRoot(process.cwd());
  const selfName = opts.selfName;
  const depPkgName = `@kici-dev/${depName}`;

  if (selfName && selfName === depPkgName) {
    return { version: 'unknown', bundleHash: 'unknown' };
  }

  const depDir = path.join(root, 'packages', depName);
  let version = 'unknown';
  try {
    const depPkg = JSON.parse(readFileSync(path.join(depDir, 'package.json'), 'utf-8'));
    if (typeof depPkg.version === 'string') version = depPkg.version;
  } catch {
    // Peer not in workspace — stays 'unknown'.
  }

  let bundleHash = 'unknown';
  try {
    const distBytes = readFileSync(path.join(depDir, 'dist', 'index.js'));
    bundleHash = createHash('sha256').update(distBytes).digest('hex');
  } catch {
    // dist/ not built yet — stays 'unknown'.
  }

  return { version, bundleHash };
}

/**
 * The version a service bundle reports as `KICI_PKG_VERSION`: a published
 * package's own version (the single-version invariant), or for a private one
 * (the Platform, whose placeholder version never moves) the repository root's.
 * A bump writes the root and the published packages the private one depends
 * on, so its task hash moves with the root version.
 *
 * @param {{ version: string, private?: boolean }} pkg the package's package.json
 * @param {() => string} readReleaseVersion reads the repository root's version;
 *   called for a private package only
 * @returns {string}
 */
export function serviceVersion(pkg, readReleaseVersion) {
  return pkg.private ? readReleaseVersion() : pkg.version;
}

/**
 * The build-time constants baked into a service bundle (and, by
 * `scripts/package.mjs`, the standalone packages), JSON-encoded so rolldown
 * replaces each identifier with a string literal.
 *
 * No build commit: it names a commit in the private repository, and every
 * service shows its constants to customers (`/health`, the startup log,
 * `kici-admin … status`).
 *
 * @param {{ version: string, buildDate: string,
 *   sdkMeta: { version: string, bundleHash: string },
 *   sharedMeta: { version: string, bundleHash: string },
 *   engineMeta: { version: string, bundleHash: string } }} input
 * @returns {Record<string, string>}
 */
export function serviceDefines({ version, buildDate, sdkMeta, sharedMeta, engineMeta }) {
  return {
    KICI_PKG_VERSION: JSON.stringify(version),
    KICI_BUILD_DATE: JSON.stringify(buildDate),
    // Drift diagnostics: did agent and orchestrator ship the same sdk bundle?
    // See docs/operator/troubleshooting.md.
    KICI_SDK_VERSION: JSON.stringify(sdkMeta.version),
    KICI_SDK_BUNDLE_HASH: JSON.stringify(sdkMeta.bundleHash),
    KICI_SHARED_VERSION: JSON.stringify(sharedMeta.version),
    KICI_SHARED_BUNDLE_HASH: JSON.stringify(sharedMeta.bundleHash),
    KICI_ENGINE_VERSION: JSON.stringify(engineMeta.version),
    KICI_ENGINE_BUNDLE_HASH: JSON.stringify(engineMeta.bundleHash),
  };
}

async function main() {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
  const entries = pkg.build?.entries;

  if (!entries || typeof entries !== 'object') {
    console.error('No "build.entries" found in package.json');
    process.exit(1);
  }

  // Dev-only entries (e.g. a fault-injecting orchestrator test double) build
  // ONLY with `--dev` or KICI_BUILD_DEV_ENTRIES=1. A release build passes
  // neither, so they never reach an npm tarball or a container image.
  const includeDevEntries =
    process.argv.includes('--dev') || process.env.KICI_BUILD_DEV_ENTRIES === '1';
  const devEntries = pkg.build?.devEntries;
  const allEntries =
    includeDevEntries && devEntries && typeof devEntries === 'object'
      ? { ...entries, ...devEntries }
      : entries;

  const buildDate = new Date().toISOString();

  const repoRoot = findRepoRoot(cwd);
  const sdkMeta = readDepMeta('sdk', { repoRoot, selfName: pkg.name });
  const sharedMeta = readDepMeta('shared', { repoRoot, selfName: pkg.name });
  const engineMeta = readDepMeta('engine', { repoRoot, selfName: pkg.name });
  const defines = serviceDefines({
    version: serviceVersion(
      pkg,
      () => JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version,
    ),
    buildDate,
    sdkMeta,
    sharedMeta,
    engineMeta,
  });

  // Staged, then renamed atomically, so a concurrent reader never sees a
  // missing module.
  const stage = stageDir(cwd);

  // ESM shim for __filename/__dirname (e.g. peer cluster code).
  const esmCjsShimBanner = `import { fileURLToPath as __cjs_fileURLToPath } from 'node:url';
import { dirname as __cjs_dirname } from 'node:path';
const __filename = __cjs_fileURLToPath(import.meta.url);
const __dirname = __cjs_dirname(__filename);
`;

  // Prepended only to chunks using the globals, so browser-safe subpaths stay
  // free of node:url/node:path imports a browser bundler cannot resolve.
  // MagicString.prepend makes rolldown offset the sourcemap; a manual concat
  // after the map is computed would break stack-trace resolution.
  const conditionalCjsShimPlugin = {
    name: 'conditional-cjs-shim',
    renderChunk(code) {
      if (!usesCjsGlobals(code)) return null;
      const ms = new RolldownMagicString(code);
      ms.prepend(esmCjsShimBanner);
      return ms;
    },
  };

  for (const [outputFile, srcFile] of Object.entries(allEntries)) {
    const inputPath = path.join(cwd, srcFile);
    const outputPath = path.join(stage, outputFile);

    const isBundleEntry = BUNDLE_ENTRIES.has(outputFile);
    const externalForEntry = isBundleEntry ? nodeBuiltinExternal : [/^[^./]/];

    await build({
      input: inputPath,
      platform: 'node',
      external: externalForEntry,
      // Shake ONLY the self-contained bundles: inlined barrels otherwise drag
      // in unreached deps (winston file-rotator, pg-native, aws-sdk) and
      // dynamic `require()`s a bare job container cannot resolve.
      treeshake: isBundleEntry,
      plugins: [conditionalCjsShimPlugin],
      transform: { define: defines },
      output: {
        file: outputPath,
        format: 'es',
        sourcemap: true,
        codeSplitting: false, // Dynamic imports inlined
      },
    });

    const size = statSync(outputPath).size;
    const sizeKB = (size / 1024).toFixed(1);
    console.log(`  ${outputFile} (${sizeKB} KB)`);
  }

  const published = publishStagedDist(cwd);
  assertPublished(cwd, published);
  pruneStaleArtifacts(cwd, published);
  pruneOrphanDeclarations(cwd);

  console.log(`Built ${Object.keys(allEntries).length} entry points to dist/`);
  // One line of baked dep metadata makes drift visible in local builds.
  const shortHash = (h) => (h === 'unknown' ? 'unknown' : h.slice(0, 12));
  console.log(
    `  deps: sdk=${sdkMeta.version}@${shortHash(sdkMeta.bundleHash)} ` +
      `shared=${sharedMeta.version}@${shortHash(sharedMeta.bundleHash)} ` +
      `engine=${engineMeta.version}@${shortHash(engineMeta.bundleHash)}`,
  );
}

// Not on import: tests import `readDepMeta` without a rolldown run.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  await main();
}
