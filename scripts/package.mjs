#!/usr/bin/env node
/**
 * KiCI packaging script.
 *
 * Produces "full" packages (Node.js binary and npm + CJS bundle + launcher) and
 * "light" packages (CJS bundle + launcher only) for all KiCI components.
 *
 * Pipeline:
 *   1. Bundle TypeScript into single CJS file via rolldown (once per target)
 *   2. Download the official Node.js archive from nodejs.org and keep its node
 *      binary and npm (once per version+platform, cached; scripts/lib/node-dist.mjs)
 *   3. Assemble package directory with launcher script, and the license, notice
 *      and source files (scripts/lib/notices.mjs)
 *   4. Create archive (.tar.gz for Unix, .zip for Windows), read it back and
 *      check it carries those files
 *
 * Usage:
 *   node scripts/package.mjs                                              # All targets, all platforms, full+light
 *   node scripts/package.mjs --target kici-admin                          # One target, all platforms
 *   node scripts/package.mjs --target kici-admin --platform linux-x64     # One target, one platform
 *   node scripts/package.mjs --target kici-admin --platform linux-x64 --light  # Light package only
 *   node scripts/package.mjs --target kici-admin --platform linux-x64 --full   # Full package only
 *   node scripts/package.mjs --output-dir dist/packages                   # Custom output dir
 *   node scripts/package.mjs --node-version 24.14.0                       # Override Node version
 *   node scripts/package.mjs --version 0.1.0                              # Override package version
 *   node scripts/package.mjs --list --version 0.1.0                       # Print the planned archives as JSON
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  statSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { readDepMeta, serviceDefines } from './build-service.mjs';
import {
  fullUnixLauncher,
  fullWindowsLauncher,
  lightUnixLauncher,
  lightWindowsLauncher,
} from './lib/launchers.mjs';
import { readArchiveFiles } from './lib/archive-reader.mjs';
import { NODE_DIST_LICENSE, copyNodeDistIntoPackage, ensureNodeDist } from './lib/node-dist.mjs';
import {
  LICENSES_MATRIX_FILE,
  LICENSE_FILE,
  NODE_LICENSE_FILE,
  NOTICES_FILE,
  SOURCE_FILE,
  archiveCheckPaths,
  checkPackageArchive,
  collectBundledPackages,
  collectInstalledPackages,
  renderNotices,
  renderSource,
} from './lib/notices.mjs';
import {
  IMAGE_DIGEST_RECORD_FILE,
  IMAGE_DIGEST_RECORD_TARGETS,
  PACKAGE_PLATFORMS,
  PACKAGE_TARGETS,
  archiveFileName,
  parseImageDigestRecord,
  packageDirName,
  packagingOutcome,
  planArchives,
  platformLabel,
  selectMatrix,
} from './lib/package-plan.mjs';
import { writeZip } from './lib/zip-writer.mjs';

// --- CLI args ---

const { values: args } = parseArgs({
  options: {
    target: { type: 'string' },
    platform: { type: 'string' },
    light: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'output-dir': { type: 'string', default: 'dist/packages' },
    'node-version': { type: 'string' },
    version: { type: 'string' },
    list: { type: 'boolean', default: false },
    'image-digest-record': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`Usage: node scripts/package.mjs [options]
  --target <name>         Build only one target (e.g. kici-admin)
  --platform <plat>       Build only one platform (e.g. linux-x64)
  --light                 Build only light packages (no Node binary)
  --full                  Build only full packages (with Node binary and npm)
  --output-dir <dir>      Output directory (default: dist/packages)
  --node-version <ver>    Node.js version to embed (default: current runtime version)
  --version <ver>         Package version string (default: from package.json)
  --list                  Print the archives this run would build, as JSON, and build nothing
  --image-digest-record <file>
                          Put this container-image digest record into the kici-admin
                          packages, so their compose installs pin images by digest
                          (default: none; the installer then pins :latest)
  --help                  Show this help

Targets: ${PACKAGE_TARGETS.map((t) => t.name).join(', ')}
Platforms: ${PACKAGE_PLATFORMS.map(platformLabel).join(', ')}`);
  process.exit(0);
}

// Native modules that can't be bundled -- they need .node binary files at runtime.
const NATIVE_EXTERNALS = ['pg-native', 'better-sqlite3', 'cpu-features', /\.node$/];

// --- Configuration ---

const outputDir = path.resolve(args['output-dir']);

// Resolve Node.js version
const nodeVersion = args['node-version'] || process.version.replace(/^v/, '');

// Resolve package version
function getPackageVersion() {
  if (args.version) return args.version;
  try {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf-8'));
    if (pkg.version) return pkg.version;
  } catch {
    // ignore
  }
  return '0.0.0-dev';
}
const packageVersion = getPackageVersion();

let selection;
try {
  selection = selectMatrix({
    target: args.target,
    platform: args.platform,
    light: args.light,
    full: args.full,
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
const { targets, platforms, types } = selection;
const planned = planArchives({ version: packageVersion, targets, platforms, types });

// `--list` prints the archives this run would build and builds nothing: no
// directory is created. A release reads it to name its assets.
if (args.list) {
  console.log(JSON.stringify(planned));
  process.exit(0);
}

// The build-time constants scripts/build-service.mjs bakes into the npm and
// image bundles. Without them a packaged orchestrator or kici-admin reports
// version 0.0.1 and a packaged agent `unknown`. Every caller runs this script
// from the repo root.
const defines = serviceDefines({
  version: packageVersion,
  buildDate: new Date().toISOString(),
  sdkMeta: readDepMeta('sdk', { repoRoot: process.cwd() }),
  sharedMeta: readDepMeta('shared', { repoRoot: process.cwd() }),
  engineMeta: readDepMeta('engine', { repoRoot: process.cwd() }),
});

// The image-digest record the kici-admin installer pins compose images from.
// A release passes the record it wrote for its images; without it the
// packages carry none and the installer pins `:latest`. A missing or malformed
// record fails here, before any bundle is built.
const imageDigestRecordPath = args['image-digest-record']
  ? path.resolve(args['image-digest-record'])
  : null;
if (imageDigestRecordPath !== null) {
  try {
    parseImageDigestRecord(readFileSync(imageDigestRecordPath, 'utf-8'), imageDigestRecordPath);
  } catch (err) {
    console.error(`Error: --image-digest-record: ${err.message}`);
    process.exit(1);
  }
}

// Node.js download cache: one <os>-<arch>/ directory per platform, holding the
// runtime and npm in the official archive's layout (scripts/lib/node-dist.mjs).
const nodeCacheBase = path.join(
  process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '/tmp', '.cache'),
  'kici',
  'node-binaries',
  `v${nodeVersion}`,
);

mkdirSync(outputDir, { recursive: true });

/**
 * Per-invocation scratch dir for the intermediate rolldown output.
 *
 * The bundles are platform-independent, so several concurrent invocations
 * (a build that packages several platforms at once, one invocation each)
 * would otherwise write and read the SAME `<outputDir>/<target>.cjs` / `.mjs`.
 * One process reading a file another is mid-write produces a silently truncated
 * — even empty — bundle, which ships as a service that starts and exits 0.
 * Scoping the intermediates per process keeps parallel packaging safe.
 */
const bundleScratchDir = path.join(
  outputDir,
  `.bundle-${process.pid}-${randomBytes(4).toString('hex')}`,
);
mkdirSync(bundleScratchDir, { recursive: true });

/**
 * Bundler-generated modules and the package that generates each: rolldown
 * inlines its runtime helpers into every bundle, so the notices name rolldown.
 * `virtualDirs` serves the notices, `virtualPackages` the archive check.
 */
const rolldownDir = path.dirname(createRequire(import.meta.url).resolve('rolldown/package.json'));
const virtualDirs = { '\0rolldown/runtime.js': rolldownDir };
const virtualPackages = {
  '\0rolldown/': `rolldown@${JSON.parse(readFileSync(path.join(rolldownDir, 'package.json'), 'utf-8')).version}`,
};

/**
 * The KiCI workspace packages, name → directory, and name → version. A KiCI
 * package installed into a package's node_modules is described from its
 * workspace.
 */
const workspaceManifests = readdirSync('packages')
  .filter((dir) => existsSync(path.join('packages', dir, 'package.json')))
  .map((dir) => ({
    dir: path.resolve('packages', dir),
    manifest: JSON.parse(readFileSync(path.join('packages', dir, 'package.json'), 'utf-8')),
  }));
const workspaceDirs = new Map(workspaceManifests.map((w) => [w.manifest.name, w.dir]));
const workspaceVersions = new Map(
  workspaceManifests.map((w) => [w.manifest.name, w.manifest.version]),
);

/** Smallest plausible bundle. Anything below this is a truncated/empty write. */
const MIN_BUNDLE_BYTES = 4096;

/** Fail loudly on a truncated or empty bundle instead of shipping a dead service. */
function assertBundleUsable(bundlePath, label) {
  const size = existsSync(bundlePath) ? statSync(bundlePath).size : 0;
  if (size < MIN_BUNDLE_BYTES) {
    throw new Error(
      `Bundle ${label} is ${size} bytes (< ${MIN_BUNDLE_BYTES}) — refusing to package a truncated bundle`,
    );
  }
}

// --- Step 1: Bundle with rolldown ---

/** The id of every module rolldown put into an output: what the notices describe. */
function outputModuleIds(output) {
  return output.output.filter((o) => o.type === 'chunk').flatMap((c) => c.moduleIds);
}

/**
 * Bundle one target. Returns the bundle and the ids of the modules in it.
 *
 * @returns {Promise<{ bundlePath: string, moduleIds: string[] }>}
 */
async function bundleTarget(target) {
  const bundlePath = path.join(bundleScratchDir, `${target.name}.cjs`);
  console.log(`  [bundle] ${target.entry} -> ${target.name}.cjs`);

  const { build } = await import('rolldown');

  // Try CJS format first (works when entry has no top-level await)
  try {
    const output = await build({
      input: path.resolve(target.entry),
      platform: 'node',
      external: NATIVE_EXTERNALS,
      treeshake: true,
      transform: { define: defines },
      resolve: {
        conditionNames: ['node', 'require', 'default'],
      },
      output: {
        file: bundlePath,
        format: 'cjs',
        codeSplitting: false,
      },
    });
    return { bundlePath, moduleIds: outputModuleIds(output) };
  } catch (err) {
    if (!err.message?.includes('Top-level await')) {
      throw err;
    }
  }

  // Fallback: bundle as ESM (supports TLA), then wrap for CJS compatibility
  console.log(`  [bundle] TLA detected, falling back to ESM+wrapper for CJS compatibility`);
  const esmPath = bundlePath.replace('.cjs', '.mjs');

  const esmOutput = await build({
    input: path.resolve(target.entry),
    platform: 'node',
    external: NATIVE_EXTERNALS,
    treeshake: true,
    transform: { define: defines },
    resolve: {
      conditionNames: ['node', 'require', 'default'],
    },
    output: {
      file: esmPath,
      format: 'esm',
      codeSplitting: false,
    },
  });

  // Wrap ESM output in a CJS-compatible async IIFE.
  const esmContent = readFileSync(esmPath, 'utf-8');
  let converted = esmContent;

  // import X from 'mod'
  converted = converted.replace(
    /^import\s+([\w$]+)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (_, name, mod) => `const ${name} = require("${mod}");`,
  );
  // import * as X from 'mod'
  converted = converted.replace(
    /^import\s+\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (_, name, mod) => `const ${name} = require("${mod}");`,
  );
  // import { a, b } from 'mod'  (also handles `import { x as y }` -> `const { x: y }`)
  converted = converted.replace(
    /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (_, names, mod) => {
      const fixedNames = names.replace(/(\w+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const {${fixedNames}} = require("${mod}");`;
    },
  );
  // import X, { a, b } from 'mod' (default + named)
  converted = converted.replace(
    /^import\s+([\w$]+),\s*\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (_, def, names, mod) => {
      const fixedNames = names.replace(/(\w+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const ${def} = require("${mod}"); const {${fixedNames}} = ${def};`;
    },
  );
  // import 'mod' (side-effect)
  converted = converted.replace(
    /^import\s+["']([^"']+)["'];?\s*$/gm,
    (_, mod) => `require("${mod}");`,
  );
  // Replace import.meta references with CJS equivalents
  converted = converted.replace(/import\.meta\.url/g, '`file://${__filename}`');
  converted = converted.replace(/import\.meta\.dirname/g, '__dirname');
  converted = converted.replace(/import\.meta\.filename/g, '__filename');
  converted = converted.replace(/import\.meta\.env/g, 'process.env');
  converted = converted.replace(/import\.meta/g, '({ url: `file://${__filename}` })');
  // Remove export statements
  converted = converted.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  converted = converted.replace(/^export\s+default\s+/gm, 'module.exports = ');
  // Replace package.json requires with a stub
  converted = converted.replace(
    /require\(["']\.\.\/package\.json["']\)/g,
    '({ version: "0.0.0-bundled" })',
  );
  converted = converted.replace(
    /createRequire\([^)]+\)\(["'][^"']*package\.json["']\)/g,
    '({ version: "0.0.0-bundled" })',
  );

  const cjsContent = [`"use strict";`, `(async () => {`, converted, `})();`].join('\n');
  writeFileSync(bundlePath, cjsContent);
  return { bundlePath, moduleIds: outputModuleIds(esmOutput) };
}

// --- Step 2.5: Bundle companion files ---

/**
 * Bundle the agent's workflow-runner as a separate CJS file.
 *
 * The agent spawns workflow-runner.js as a child process (sandboxed execution),
 * so it can't be included in the main agent bundle. The runner needs to exist
 * as a separate file at lib/sandbox/workflow-runner.js relative to the agent
 * bundle (matching resolveRunnerPath() in job-runner.ts).
 *
 * @returns {Promise<{ bundlePath: string, moduleIds: string[] }>}
 */
async function bundleWorkflowRunner() {
  const runnerEntry = 'packages/agent/src/execution/sandbox/workflow-runner.ts';
  const runnerOut = path.join(bundleScratchDir, 'workflow-runner.cjs');
  console.log(`  [bundle] ${runnerEntry} -> workflow-runner.cjs (agent companion)`);

  const { build } = await import('rolldown');
  const output = await build({
    input: path.resolve(runnerEntry),
    platform: 'node',
    external: [...NATIVE_EXTERNALS, 'rolldown'],
    treeshake: true,
    transform: { define: defines },
    resolve: {
      conditionNames: ['node', 'require', 'default'],
    },
    output: {
      file: runnerOut,
      format: 'cjs',
      codeSplitting: false,
    },
  });

  return { bundlePath: runnerOut, moduleIds: outputModuleIds(output) };
}

// --- Step 2.6: Runtime companion deps (for workflow-runner's loader hook) ---

/**
 * Install `oxc-transform` + scaffold the minimal `@kici-dev/core/ts-loader-hook`
 * subpath export into `pkgDir/node_modules/`.
 *
 * Background: workflow-runner.cjs (bundled by `bundleWorkflowRunner`) calls
 * `register('@kici-dev/core/ts-loader-hook', import.meta.url)` to install a
 * Node ESM loader hook that transforms `.ts` files on import via
 * `oxc-transform`. `register()` resolves its specifier at *runtime* against
 * the bundled file's location — bundling does NOT inline the target.
 *
 * Both specifiers must therefore exist as real files on disk, reachable from
 * `pkgDir/lib/sandbox/workflow-runner.js` via Node's node_modules walk. We
 * ship them at `pkgDir/node_modules/` (the package root), which is one
 * directory up from `lib/` in every extracted layout.
 *
 * `oxc-transform` ships native NAPI bindings per (os, arch) via sibling
 * `@oxc-transform/binding-<platform>` packages, so we install for the TARGET
 * platform (not the host) via `npm install --cpu=<arch> --os=<os>`.
 */
function installRuntimeCompanions(pkgDir, platform) {
  // 1. Install oxc-transform for the target platform FIRST. `npm install`
  // rewrites node_modules against its own package-lock.json, so if we seed
  // @kici-dev/core before this step, npm removes it ("removed 1 package").
  // Version pinned to whatever @kici-dev/core depends on so the hook and
  // the native bindings stay in lock step.
  const corePkgJson = JSON.parse(
    readFileSync(path.join(process.cwd(), 'packages/core/package.json'), 'utf-8'),
  );
  const oxcVersion = corePkgJson.dependencies?.['oxc-transform'];
  if (!oxcVersion) {
    throw new Error(
      'oxc-transform not found in packages/core/package.json dependencies — ' +
        'keep ts-loader-hook, oxc-transform, and this packaging logic in sync',
    );
  }

  // npm's cpu/os filter expects 'arm64' / 'x64' / 'darwin' / 'linux' / 'win32'.
  const npmArch = platform.arch;
  const npmOs = platform.os === 'win' ? 'win32' : platform.os;
  console.log(`  [companion] install oxc-transform@${oxcVersion} (${npmOs}/${npmArch})`);
  execSync(
    `npm install oxc-transform@${oxcVersion} ` +
      `--prefix "${pkgDir}" ` +
      `--cpu=${npmArch} --os=${npmOs} ` +
      `--no-audit --no-fund --no-save --omit=dev --force`,
    { stdio: 'pipe', timeout: 120_000 },
  );

  // 2. Copy @kici-dev/core/ts-loader-hook + chunks (platform-agnostic) AFTER
  // npm finishes writing node_modules. The stub package provides only the
  // `./ts-loader-hook` subpath export — everything else in @kici-dev/core
  // is either bundled into the agent output or irrelevant here.
  const nodeModulesDir = path.join(pkgDir, 'node_modules');
  const coreDistSrc = path.join(process.cwd(), 'packages/core/dist');
  const coreStubDir = path.join(nodeModulesDir, '@kici-dev/core');
  mkdirSync(path.join(coreStubDir, 'dist'), { recursive: true });
  // Copy ts-loader-hook.js and every local `.js` chunk it transitively imports,
  // resolved from the actual `./`-relative specifiers. A hardcoded chunk-*.js
  // glob missed rolldown's shared runtime chunk (emitted as
  // rolldown-runtime-<hash>.js), leaving the stub's ts-loader-hook.js with an
  // unresolvable import.
  const coreSeen = new Set();
  const coreQueue = ['ts-loader-hook.js'];
  const coreLocalSpec = /['"](\.\/[^'"]+\.js)['"]/g;
  while (coreQueue.length > 0) {
    const coreFile = coreQueue.shift();
    if (coreSeen.has(coreFile)) continue;
    coreSeen.add(coreFile);
    const coreSrc = readFileSync(path.join(coreDistSrc, coreFile), 'utf-8');
    copyFileSync(path.join(coreDistSrc, coreFile), path.join(coreStubDir, 'dist', coreFile));
    for (const m of coreSrc.matchAll(coreLocalSpec)) {
      const dep = m[1].replace(/^\.\//, '');
      if (!coreSeen.has(dep)) coreQueue.push(dep);
    }
  }
  // The stub is @kici-dev/core code, so it carries that package's license.
  copyFileSync(
    path.join(process.cwd(), 'packages/core', LICENSE_FILE),
    path.join(coreStubDir, LICENSE_FILE),
  );
  writeFileSync(
    path.join(coreStubDir, 'package.json'),
    JSON.stringify(
      {
        name: '@kici-dev/core',
        version: '0.0.0-package-stub',
        type: 'module',
        exports: {
          './ts-loader-hook': { import: './dist/ts-loader-hook.js' },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

// --- Step 3: Assemble package directory ---

/**
 * Write the license, notice and source files at the package root. The notices
 * cover the packages bundled into the target and the packages installed
 * beside the bundle.
 */
function writeLicenseFiles(pkgDir, target, type, nodeDistDir, bundled) {
  const licenseText = readFileSync(path.join(target.licenseDir, LICENSE_FILE), 'utf-8');
  writeFileSync(path.join(pkgDir, LICENSE_FILE), licenseText);
  copyFileSync(LICENSES_MATRIX_FILE, path.join(pkgDir, LICENSES_MATRIX_FILE));
  if (type === 'full') {
    copyFileSync(path.join(nodeDistDir, NODE_DIST_LICENSE), path.join(pkgDir, NODE_LICENSE_FILE));
  }
  const packages = new Map(bundled);
  const installed = collectInstalledPackages(path.join(pkgDir, 'node_modules'), workspaceDirs);
  for (const [key, pkg] of installed) if (!packages.has(key)) packages.set(key, pkg);
  writeFileSync(
    path.join(pkgDir, NOTICES_FILE),
    renderNotices({ component: target.name, version: packageVersion, packages, licenseText }),
  );
  writeFileSync(
    path.join(pkgDir, SOURCE_FILE),
    renderSource({ component: target.name, version: packageVersion, type }),
  );
}

/**
 * Assemble a package directory for the given target, platform, and type.
 */
function assemblePackage(bundlePath, target, platform, type, nodeDistDir, companions, bundled) {
  const dirName = packageDirName(target.name, packageVersion, platform, type);
  const pkgDir = path.join(outputDir, dirName);

  // Clean and create
  if (existsSync(pkgDir)) rmSync(pkgDir, { recursive: true });
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });

  // Copy bundle
  copyFileSync(bundlePath, path.join(pkgDir, 'lib', `${target.name}.cjs`));

  // Copy companion files (e.g., workflow-runner for agent)
  if (companions) {
    for (const { src, dest } of companions) {
      const destPath = path.join(pkgDir, 'lib', dest);
      mkdirSync(path.dirname(destPath), { recursive: true });
      copyFileSync(src, destPath);
    }
  }

  if (imageDigestRecordPath !== null && IMAGE_DIGEST_RECORD_TARGETS.includes(target.name)) {
    copyFileSync(imageDigestRecordPath, path.join(pkgDir, IMAGE_DIGEST_RECORD_FILE));
  }

  // Install runtime companions for kici-agent (hook + oxc-transform). The
  // bundled workflow-runner.cjs registers `@kici-dev/core/ts-loader-hook` at
  // runtime; without the hook + its oxc-transform native binding present at
  // pkgDir/node_modules/, every customer workflow import fails with
  // ERR_MODULE_NOT_FOUND. Skip for non-agent targets to keep packages small.
  if (target.name === 'kici-agent') {
    installRuntimeCompanions(pkgDir, platform);
  }

  // Copy the Node.js runtime and npm (full packages only).
  if (type === 'full' && nodeDistDir) {
    copyNodeDistIntoPackage(nodeDistDir, pkgDir, platform);
  }

  // Write launcher script
  const isWindows = platform.os === 'win';
  const launcherName = `${target.name}${platform.launcherExt}`;
  let launcherContent;

  if (type === 'full') {
    launcherContent = isWindows ? fullWindowsLauncher(target.name) : fullUnixLauncher(target.name);
  } else {
    launcherContent = isWindows
      ? lightWindowsLauncher(target.name, nodeVersion, platform)
      : lightUnixLauncher(target.name, nodeVersion, platform);
  }

  writeFileSync(path.join(pkgDir, launcherName), launcherContent);
  if (!isWindows) {
    chmodSync(path.join(pkgDir, launcherName), 0o755);
  }

  writeLicenseFiles(pkgDir, target, type, nodeDistDir, bundled);
  return { pkgDir, dirName };
}

// --- Step 4: Create archive ---

/**
 * Create an archive from a package directory.
 * Uses tar.gz for Unix platforms and zip for Windows.
 */
async function createArchive(pkgDir, dirName, format, outputPath) {
  if (format === 'tar.gz') {
    // Use tar command for reliable tar.gz creation with proper permissions
    const parentDir = path.dirname(pkgDir);
    execSync(`tar -czf "${outputPath}" -C "${parentDir}" "${dirName}"`, { stdio: 'pipe' });
  } else if (format === 'zip') {
    writeZip(path.dirname(pkgDir), dirName, outputPath);
  } else {
    throw new Error(`Unknown archive format: ${format}`);
  }

  return outputPath;
}

/**
 * Read a built archive back and fail when it lacks a license, notice or source
 * file, or when its notices omit a package whose code it carries: the check
 * reads the packages from the archive's own bundles and node_modules. The
 * archive is deleted on failure, so no incomplete package is left to publish.
 */
function verifyArchive(archivePath, dirName, format, type) {
  let problems;
  try {
    problems = checkPackageArchive({
      archive: readArchiveFiles(archivePath, format, (entries) =>
        archiveCheckPaths(entries, dirName),
      ),
      dirName,
      type,
      root: process.cwd(),
      virtualPackages,
      workspaceVersions,
    });
  } catch (err) {
    rmSync(archivePath, { force: true });
    throw new Error(`${path.basename(archivePath)} could not be checked: ${err.message}`);
  }
  if (problems.length > 0) {
    rmSync(archivePath, { force: true });
    throw new Error(`${path.basename(archivePath)} is incomplete: ${problems.join('; ')}`);
  }
}

// --- Main ---

const results = [];
/** Human-readable failures; any entry fails the run. */
const failures = [];

async function packageAll() {
  console.log(`KiCI Packaging`);
  console.log(`  Version: ${packageVersion}`);
  console.log(`  Node.js: v${nodeVersion}`);
  console.log(`  Targets: ${targets.map((t) => t.name).join(', ')}`);
  console.log(`  Platforms: ${platforms.map(platformLabel).join(', ')}`);
  console.log(`  Types: ${types.join(' + ')}`);
  console.log(`  Image digests: ${imageDigestRecordPath ?? 'none'}`);
  console.log(`  Output: ${outputDir}`);
  console.log('');

  // Step 1: Bundle all targets (platform-independent)
  const bundles = new Map();
  for (const target of targets) {
    try {
      const bundle = await bundleTarget(target);
      assertBundleUsable(bundle.bundlePath, `${target.name}.cjs`);
      bundles.set(target.name, bundle);
    } catch (err) {
      failures.push(`bundle ${target.name}: ${err.message}`);
      console.error(`  ERROR: Bundle failed for ${target.name}: ${err.message}`);
    }
  }

  // Step 1.5: the agent's workflow runner. An agent package without it cannot
  // run a job, so a failure here drops the agent packages.
  let workflowRunner = null;
  if (bundles.has('kici-agent')) {
    try {
      workflowRunner = await bundleWorkflowRunner();
      assertBundleUsable(workflowRunner.bundlePath, 'workflow-runner.cjs');
    } catch (err) {
      failures.push(`workflow-runner: ${err.message}`);
      console.error(`  ERROR: Failed to bundle workflow-runner: ${err.message}`);
      bundles.delete('kici-agent');
    }
  }

  // Step 1.6: the packages whose code each target's bundles carry, with their
  // license texts. A bundled package with no license text drops the target.
  const bundledPackages = new Map();
  for (const target of targets) {
    const bundle = bundles.get(target.name);
    if (!bundle) continue;
    const moduleIds =
      target.name === 'kici-agent'
        ? [...bundle.moduleIds, ...workflowRunner.moduleIds]
        : bundle.moduleIds;
    try {
      bundledPackages.set(target.name, collectBundledPackages(moduleIds, { virtualDirs }));
    } catch (err) {
      failures.push(`notices ${target.name}: ${err.message}`);
      console.error(`  ERROR: Notices failed for ${target.name}: ${err.message}`);
      bundles.delete(target.name);
    }
  }

  // Steps 2-4: for each (target, platform, type), assemble and archive
  for (const target of targets) {
    const bundle = bundles.get(target.name);
    if (!bundle) continue;
    const companions =
      target.name === 'kici-agent'
        ? [{ src: workflowRunner.bundlePath, dest: 'sandbox/workflow-runner.js' }]
        : [];
    for (const platform of platforms) {
      const platLabel = platformLabel(platform);
      for (const type of types) {
        const dirName = packageDirName(target.name, packageVersion, platform, type);
        try {
          console.log(`\n--- ${target.name} / ${platLabel} / ${type} ---`);
          const nodeDistDir =
            type === 'full'
              ? await ensureNodeDist({ version: nodeVersion, platform, cacheBase: nodeCacheBase })
              : null;
          const { pkgDir } = assemblePackage(
            bundle.bundlePath,
            target,
            platform,
            type,
            nodeDistDir,
            companions,
            bundledPackages.get(target.name),
          );
          const archiveName = archiveFileName(target.name, packageVersion, platform, type);
          const archivePath = path.join(outputDir, archiveName);
          await createArchive(pkgDir, dirName, platform.archiveFormat, archivePath);
          verifyArchive(archivePath, dirName, platform.archiveFormat, type);
          const size = statSync(archivePath).size;
          results.push({
            target: target.name,
            platform: platLabel,
            type,
            archive: archivePath,
            size,
          });
          console.log(`  Done: ${archiveName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        } catch (err) {
          failures.push(`${target.name} ${platLabel} ${type}: ${err.message}`);
          console.error(`  ERROR (${type}): ${err.message}`);
        } finally {
          rmSync(path.join(outputDir, dirName), { recursive: true, force: true });
        }
      }
    }
  }

  if (results.length > 0) {
    console.log('\n=== Packaging Summary ===');
    console.log(
      `${'Target'.padEnd(32)} ${'Platform'.padEnd(14)} ${'Type'.padEnd(8)} ${'Size'.padEnd(12)} Archive`,
    );
    console.log(
      `${'---'.padEnd(32)} ${'---'.padEnd(14)} ${'---'.padEnd(8)} ${'---'.padEnd(12)} ---`,
    );
    for (const r of results) {
      const sizeMB = (r.size / 1024 / 1024).toFixed(1) + ' MB';
      console.log(
        `${r.target.padEnd(32)} ${r.platform.padEnd(14)} ${r.type.padEnd(8)} ${sizeMB.padEnd(12)} ${path.basename(r.archive)}`,
      );
    }
  }

  const outcome = packagingOutcome({
    planned,
    built: results.map((r) => path.basename(r.archive)),
    failures,
  });
  if (outcome.exitCode !== 0) {
    console.error('\nPackaging failed: a requested archive was not built.');
    for (const f of failures) console.error(`  ${f}`);
    for (const m of outcome.missing) console.error(`  not built: ${m}`);
  } else {
    console.log(`\nPackaged ${results.length} archive(s) successfully.`);
  }
  return outcome.exitCode;
}

// process.exit skips `finally`, so the exit code is computed first and the
// scratch directory is removed on every path, a failed run included.
let exitCode = 1;
try {
  exitCode = await packageAll();
} finally {
  rmSync(bundleScratchDir, { recursive: true, force: true });
}
process.exit(exitCode);
