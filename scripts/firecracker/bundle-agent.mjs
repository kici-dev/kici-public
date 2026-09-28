#!/usr/bin/env node
// Bundle the KiCI agent, workflow-runner and eval-runner into single-file ESM
// bundles for Firecracker rootfs injection, with Rolldown, the bundler the rest
// of the build uses.
//
// Usage: node scripts/firecracker/bundle-agent.mjs <output-dir>
//
// Produces:
//   <output-dir>/agent.js           — agent server bundle
//   <output-dir>/sandbox/workflow-runner.js — workflow runner bundle (forked by agent)
//   <output-dir>/eval-runner.js      — eval runner bundle (forked by agent)

import { build } from 'rolldown';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('Usage: node bundle-agent.mjs <output-dir>');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const monorepoRoot = path.resolve(import.meta.dirname, '..', '..');

// ESM banner: inject a require() shim so CommonJS dependencies (winston, etc.)
// that call require("util") work inside the ESM bundle.
const banner = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

// Bundle agent server (single file: codeSplitting is off)
await build({
  input: path.join(monorepoRoot, 'packages/agent/src/server.ts'),
  platform: 'node',
  external: [
    'cpu-features',
    'dockerode',
    // `oxc-transform` has a native N-API binding and can't be bundled. It's
    // pulled in by `@kici-dev/core/ts-loader-hook`, which the workflow-runner
    // registers at startup so imports of `.kici/workflows/*.ts` go through the
    // oxc-based TS transform. Leaving `@kici-dev/core` bundled in-bundle
    // would still route the runtime `module.register()` call to this external
    // package path at `/opt/kici/node_modules/oxc-transform/`.
    'oxc-transform',
    '@kici-dev/core/ts-loader-hook',
  ],
  output: {
    dir: outputDir,
    format: 'es',
    entryFileNames: 'agent.js',
    codeSplitting: false, // one self-contained file: dynamic imports are inlined
    banner,
  },
});
console.log('Bundled agent.js');

// Bundle workflow runner (forked as child process by the agent)
const sandboxDir = path.join(outputDir, 'sandbox');
mkdirSync(sandboxDir, { recursive: true });

await build({
  input: path.join(monorepoRoot, 'packages/agent/src/execution/sandbox/workflow-runner.ts'),
  platform: 'node',
  external: [
    'cpu-features',
    'dockerode',
    // `oxc-transform` has a native N-API binding and can't be bundled. It's
    // pulled in by `@kici-dev/core/ts-loader-hook`, which the workflow-runner
    // registers at startup so imports of `.kici/workflows/*.ts` go through the
    // oxc-based TS transform. Leaving `@kici-dev/core` bundled in-bundle
    // would still route the runtime `module.register()` call to this external
    // package path at `/opt/kici/node_modules/oxc-transform/`.
    'oxc-transform',
    '@kici-dev/core/ts-loader-hook',
  ],
  output: {
    dir: sandboxDir,
    format: 'es',
    entryFileNames: 'workflow-runner.js',
    codeSplitting: false, // one self-contained file: dynamic imports are inlined
    banner,
  },
});
console.log('Bundled workflow-runner.js');

// Bundle the eval runner (forked as a child process by the agent for every
// `__init__` / `__dynamic__` / `__build__` job and every global eval round).
// It lands as a SIBLING of agent.js because `resolveEvalRunnerPath()` probes
// `join(dirname(agent entry), 'eval-runner.js')` first, and in the Firecracker
// rootfs the agent entry is `/opt/kici/agent.js`.
//
// Without it a Firecracker-hosted evaluation forks a path that does not exist:
// node starts, fails to load the module, and exits 1 with its diagnostic on a
// stderr the parent discards — surfacing as the opaque "Evaluation child exited
// without a result (code=1, signal=null)".
await build({
  input: path.join(monorepoRoot, 'packages/agent/src/execution/sandbox/eval-runner.ts'),
  platform: 'node',
  external: [
    'cpu-features',
    'dockerode',
    // Same externals as the workflow-runner: the eval child registers the same
    // oxc-based TS loader hook to import `.kici/workflows/*.ts`.
    'oxc-transform',
    '@kici-dev/core/ts-loader-hook',
  ],
  output: {
    dir: outputDir,
    format: 'es',
    entryFileNames: 'eval-runner.js',
    codeSplitting: false, // one self-contained file: dynamic imports are inlined
    banner,
  },
});
console.log('Bundled eval-runner.js');
