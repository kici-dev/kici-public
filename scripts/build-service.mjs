#!/usr/bin/env node
/**
 * Bundle a service package into single-file entry points.
 *
 * Unlike build-ts.mjs (library mode: file-per-file transpile), this script
 * produces one JS file per entry point with all internal code inlined.
 * External npm dependencies stay as bare imports resolved from node_modules.
 *
 * Usage: node ../../scripts/build-service.mjs (run from any service package directory)
 *
 * The script reads the package's build.entries field from package.json to determine
 * entry points. Each entry maps an output filename to a source file:
 *
 *   "build": { "entries": { "server.js": "src/server.ts", "worker.js": "src/worker.ts" } }
 *
 * All bare imports (anything not starting with . or /) are kept external.
 * Workspace packages (@kici-dev/*) are also external — they ship as separate packages.
 */

import { build, RolldownMagicString } from 'rolldown';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

/**
 * Whether the bundled code references the CJS-style filename/dirname globals.
 *
 * NOTE: this regex assumes minification is OFF — there is no `minify` in the
 * rolldown config below, so `__filename` / `__dirname` survive verbatim in the
 * emitted chunk. A minifier could rename these globals, which would make the
 * regex miss them and silently drop the shim from a server entry that needs it
 * (runtime `__dirname is not defined`, no build-time error). Revisit this
 * heuristic if minification is ever enabled.
 */
export const usesCjsGlobals = (code) => /\b__(filename|dirname)\b/.test(code);

// Resolve the repo root by climbing until pnpm-workspace.yaml is found.
// `private: true` alone is not a reliable marker — individual service packages
// are also private. The only unambiguous root marker is pnpm-workspace.yaml.
export function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    try {
      statSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      // Not here — climb.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd's grandparent (packages/<name>/ -> repo root).
  return path.resolve(start, '..', '..');
}

/**
 * Read a workspace dependency's version + bundle hash for drift diagnostics.
 *
 * Returns `{ version, bundleHash }` when `packages/<depName>/dist/index.js` exists,
 * or `{ version, bundleHash: 'unknown' }` when it doesn't (e.g. building shared
 * before shared's dist exists, or peer not yet built). Self-builds (depName ===
 * current pkg name) short-circuit to 'unknown' so we don't read our own stale dist.
 *
 * `dist/index.js` is produced by build-ts.mjs for shared / sdk / engine — pnpm's
 * workspace build topology (shared -> engine -> sdk -> everything else) ensures
 * the peers are fully built before agent / orchestrator / platform are bundled.
 *
 * Pure helper — no side effects — so it's directly testable. The main() block
 * below is the only caller that resolves `repoRoot` and `selfName` from the
 * process environment.
 */
export function readDepMeta(depName, opts = {}) {
  const root = opts.repoRoot ?? findRepoRoot(process.cwd());
  const selfName = opts.selfName;
  const depPkgName = `@kici-dev/${depName}`;

  // Self-build: skip (avoid reading our own stale dist/index.js).
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

async function main() {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
  const entries = pkg.build?.entries;

  if (!entries || typeof entries !== 'object') {
    console.error('No "build.entries" found in package.json');
    process.exit(1);
  }

  // Build-time constants (hardcoded into every service bundle).
  // KICI_BUILD_COMMIT env var is set by container builds (git unavailable in containers);
  // falls back to git rev-parse when building locally.
  const buildDate = new Date().toISOString();
  let buildCommit = process.env.KICI_BUILD_COMMIT || 'unknown';
  if (buildCommit === 'unknown') {
    try {
      buildCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      // git not available
    }
  }

  const repoRoot = findRepoRoot(cwd);
  const sdkMeta = readDepMeta('sdk', { repoRoot, selfName: pkg.name });
  const sharedMeta = readDepMeta('shared', { repoRoot, selfName: pkg.name });
  const engineMeta = readDepMeta('engine', { repoRoot, selfName: pkg.name });

  // Clean dist/ before building (remove stale library-mode artifacts)
  rmSync(path.join(cwd, 'dist'), { recursive: true, force: true });

  // ESM shim for modules that reference __filename/__dirname (e.g. peer cluster
  // code). It pulls in node:url + node:path, so it is prepended ONLY to entries
  // whose bundled output actually references __filename/__dirname. Browser-safe
  // subpaths (e.g. @kici-dev/platform/legal, imported by the dashboard) carry no
  // such references and therefore stay free of node built-in imports, so a
  // browser bundler can resolve them.
  const esmCjsShimBanner = `import { fileURLToPath as __cjs_fileURLToPath } from 'node:url';
import { dirname as __cjs_dirname } from 'node:path';
const __filename = __cjs_fileURLToPath(import.meta.url);
const __dirname = __cjs_dirname(__filename);
`;

  // Prepend the CJS shim only to chunks that actually reference
  // __filename/__dirname, via a renderChunk hook that returns a
  // RolldownMagicString. Going through MagicString.prepend means rolldown
  // offsets the chunk's sourcemap by the banner's line count by construction —
  // a manual string concat after rolldown computed the map would shift every
  // mapping down and break stack-trace resolution. Chunks without the globals
  // (e.g. the browser-safe @kici-dev/platform/legal subpath imported by the
  // dashboard) are returned unchanged, so they stay free of node:url/node:path
  // imports and a browser bundler can resolve them.
  const conditionalCjsShimPlugin = {
    name: 'conditional-cjs-shim',
    renderChunk(code) {
      if (!usesCjsGlobals(code)) return null;
      const ms = new RolldownMagicString(code);
      ms.prepend(esmCjsShimBanner);
      return ms;
    },
  };

  for (const [outputFile, srcFile] of Object.entries(entries)) {
    const inputPath = path.join(cwd, srcFile);
    const outputPath = path.join(cwd, 'dist', outputFile);

    await build({
      input: inputPath,
      platform: 'node',
      external: [/^[^./]/], // All bare imports external (npm deps + workspace packages)
      treeshake: false,
      plugins: [conditionalCjsShimPlugin],
      transform: {
        define: {
          KICI_PKG_VERSION: JSON.stringify(pkg.version),
          KICI_BUILD_DATE: JSON.stringify(buildDate),
          KICI_BUILD_COMMIT: JSON.stringify(buildCommit),
          // Workspace dep drift diagnostics (build-time): six strings baked per bundle.
          // Purpose: a 5-second log-grep can answer "did agent and orchestrator ship
          // the same @kici-dev/sdk bundle?" — see docs/operator/troubleshooting.md.
          KICI_SDK_VERSION: JSON.stringify(sdkMeta.version),
          KICI_SDK_BUNDLE_HASH: JSON.stringify(sdkMeta.bundleHash),
          KICI_SHARED_VERSION: JSON.stringify(sharedMeta.version),
          KICI_SHARED_BUNDLE_HASH: JSON.stringify(sharedMeta.bundleHash),
          KICI_ENGINE_VERSION: JSON.stringify(engineMeta.version),
          KICI_ENGINE_BUNDLE_HASH: JSON.stringify(engineMeta.bundleHash),
        },
      },
      output: {
        file: outputPath,
        format: 'es',
        sourcemap: true,
        codeSplitting: false, // Single-file output (dynamic imports inlined)
      },
      // write: true (default) — rolldown writes every chunk + its .map and any
      // assets to disk natively, with the shim's sourcemap offset already
      // applied by the renderChunk hook above.
    });

    const size = statSync(outputPath).size;
    const sizeKB = (size / 1024).toFixed(1);
    console.log(`  ${outputFile} (${sizeKB} KB)`);
  }

  console.log(`Built ${Object.keys(entries).length} entry points to dist/`);
  // Emit baked workspace dep metadata so local builds make drift visible in one line.
  // `unknown` indicates the peer's dist/index.js didn't exist (self-build or out-of-order).
  const shortHash = (h) => (h === 'unknown' ? 'unknown' : h.slice(0, 12));
  console.log(
    `  deps: sdk=${sdkMeta.version}@${shortHash(sdkMeta.bundleHash)} ` +
      `shared=${sharedMeta.version}@${shortHash(sharedMeta.bundleHash)} ` +
      `engine=${engineMeta.version}@${shortHash(engineMeta.bundleHash)}`,
  );
}

// Run the build only when invoked as a script — not on bare import
// (tests import `readDepMeta` without wanting the full rolldown run).
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  await main();
}
