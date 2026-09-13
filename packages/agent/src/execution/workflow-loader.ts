/**
 * Workflow module loading: transforms `.ts` workflow files on import via the
 * `@kici-dev/core/ts-loader-hook` oxc-transform ESM loader hook. Customer
 * workflow code is imported
 * directly from the cloned / extracted source tree — no intermediate bundle,
 * no Rolldown step at runtime. `@kici-dev/sdk` and host-repo deps resolve via
 * Node's normal ESM lookup against `.kici/node_modules/`.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { normalizeLineEndings, sha256 } from '@kici-dev/shared';
import {
  COMPILE_SCHEMA_VERSION,
  collectSourceSymlinks,
  findKiciDir,
  hashKiciSourceTree,
  hashedSymlinkDriftNote,
} from '@kici-dev/core/kici-source-digest';
import type { Workflow, Job, StepInput, DynamicJobFn, OutputsMap, StepRefMap } from '@kici-dev/sdk';
import { isDynamicJobFn } from '@kici-dev/sdk';
import {
  setStepOutputsMap as setStepOutputsMapBundled,
  setStepRefMap as setStepRefMapBundled,
  setJobOutputsMap as setJobOutputsMapBundled,
} from '@kici-dev/sdk/internal';
import { buildGeneratorContext, type GeneratorRepoPair } from './generator-context.js';

/**
 * SDK output-map setters resolved from a specific `@kici-dev/sdk` instance.
 * The agent uses these to wire the workflow module's OWN SDK copy (a different
 * physical module than the agent's bundled SDK) to the same output maps the
 * step loop mutates, so within-job `.result` proxies — which read that copy's
 * module-global `_stepOutputsMap` — resolve at access time.
 */
export interface SdkOutputSetters {
  setStepOutputsMap: (map: OutputsMap) => void;
  setStepRefMap: (map: StepRefMap) => void;
  setJobOutputsMap: (map: OutputsMap) => void;
}

/**
 * Resolve the `@kici-dev/sdk` instance the workflow module itself imports.
 *
 * The workflow's `.result` proxies read the module-global step-outputs map of
 * whichever SDK copy the workflow file resolves — which is generally a
 * different physical module than the agent's bundled SDK (the workflow is
 * imported from the cloned source tree and resolves its deps against that
 * tree's `node_modules`). Resolving via `createRequire(workflowFilePath)` walks
 * `node_modules` from the workflow file exactly the way the workflow's own
 * `import '@kici-dev/sdk'` does — including any hoisted copy — so the returned
 * setters mutate the SAME module-global map object the proxies read. Node caches
 * ESM modules by resolved URL, so importing that path yields the workflow's live
 * singleton, not a fresh copy.
 *
 * Both specifiers resolve to the same module-global maps — `internal.ts` and the
 * root barrel re-export the same `outputs.js` bindings — so the fallback below
 * changes which entry is imported, never which singleton is mutated.
 *
 * Falls back to the agent's bundled setters when neither resolves (mirrors
 * `resolveSdkSetters` in the compiler's test runner).
 */
export async function resolveWorkflowSdkSetters(
  workflowFilePath: string,
): Promise<SdkOutputSetters> {
  const req = createRequire(workflowFilePath);
  // The setters live on `@kici-dev/sdk/internal`; they also stay on the root
  // barrel, `@deprecated`, for the whole 0.x line. Try the subpath first and
  // fall back to the root, so a customer tree carrying an SDK older than the
  // subpath still resolves the same module-global maps its proxies read.
  for (const specifier of ['@kici-dev/sdk/internal', '@kici-dev/sdk']) {
    try {
      const sdkEntry = req.resolve(specifier);
      const sdk = (await import(pathToFileURL(sdkEntry).href)) as Partial<SdkOutputSetters>;
      if (
        typeof sdk.setStepOutputsMap === 'function' &&
        typeof sdk.setStepRefMap === 'function' &&
        typeof sdk.setJobOutputsMap === 'function'
      ) {
        return {
          setStepOutputsMap: sdk.setStepOutputsMap,
          setStepRefMap: sdk.setStepRefMap,
          setJobOutputsMap: sdk.setJobOutputsMap,
        };
      }
    } catch {
      // Try the next specifier, then the agent's bundled setters.
    }
  }
  return {
    setStepOutputsMap: setStepOutputsMapBundled,
    setStepRefMap: setStepRefMapBundled,
    setJobOutputsMap: setJobOutputsMapBundled,
  };
}

// Build-time constants injected by the agent bundler (scripts/build-service.mjs).
// The agent's baked SDK fingerprint is included in the lock-file drift error
// so an operator can correlate against the host / orchestrator SDK fingerprint
// without tailing the agent startup log.
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
const AGENT_SDK_VERSION = typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown';
const AGENT_SDK_BUNDLE_HASH =
  typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown';

/**
 * Compile schema version, re-exported from its single definition in
 * `@kici-dev/core/kici-source-digest`. The compiler mixes the same constant
 * into every `contentHash` it writes, so a second copy here is exactly how a
 * producer and its verifier drift apart.
 */
export { COMPILE_SCHEMA_VERSION } from '@kici-dev/core/kici-source-digest';

/**
 * Register the ESM loader hook that transforms `.ts` / `.tsx` files on the fly
 * for subsequent dynamic `import()` calls. Idempotent at our level via the
 * `hookRegistered` flag; Node also tolerates repeated `register()` calls by
 * stacking layers, but we avoid the noise.
 *
 * Two registration branches:
 *
 * - **Container path** — when `KICI_TS_LOADER_HOOK_PATH` is set (only
 *   `ContainerSandbox` sets it, pointing at a pure-JS hook bundle mounted into
 *   the job container), register that on-disk hook by absolute `file://` URL.
 *   `module.register` resolves the specifier on disk in a worker thread, so a
 *   bare package specifier would need a `node_modules` tree next to the runner
 *   bundle — which does not exist in a bare customer container. An absolute
 *   `file://` URL sidesteps resolution entirely.
 * - **Fork / firecracker path** — when the env var is unset, register the
 *   `@kici-dev/core/ts-loader-hook` oxc-transform hook by bare specifier,
 *   resolved via the workspace `node_modules` those sandboxes bind read-only.
 */
let hookRegistered = false;
export function ensureLoaderHookRegistered(): void {
  if (hookRegistered) return;
  const hookPath = process.env.KICI_TS_LOADER_HOOK_PATH;
  if (hookPath) {
    register(pathToFileURL(hookPath).href, import.meta.url);
  } else {
    register('@kici-dev/core/ts-loader-hook', import.meta.url);
  }
  hookRegistered = true;
}

/**
 * Compute content hash for a workflow (same formula as `@kici-dev/compiler`
 * lockfile/hasher.ts). Used to verify the loaded source matches the lock
 * file's contentHash when `expectedContentHash` is provided.
 *
 * Line endings in `rawSource` (and inside `assetDigest`) are normalized to LF
 * before hashing. This matches the compiler-side normalization in
 * `@kici-dev/compiler` `lockfile/hasher.ts` so Windows agents — where Git's
 * `core.autocrlf=true` system default checks out text files with CRLF — agree
 * with lockfiles compiled on Linux (LF).
 */
function computeContentHash(rawSource: string, assetDigest?: string): string {
  let input = `${COMPILE_SCHEMA_VERSION}:${normalizeLineEndings(rawSource)}`;
  if (assetDigest !== undefined && assetDigest.length > 0) {
    input += `\0${normalizeLineEndings(assetDigest)}`;
  }
  return sha256(input);
}

/**
 * The compile schema version the lock file records for `sourceFile`, or null
 * when the tree carries no readable lock (a `file://` in-place run, a workflow
 * outside the `.kici/` convention, a hand-built fixture).
 *
 * The source tarball carries `.kici/kici.lock.json` — the digest excludes it,
 * but `source-packer.ts` packs it — so the agent can read the producing
 * compiler's schema version from the tree it already has, with no wire field
 * to plumb and no protocol change.
 *
 * A malformed or unreadable lock returns null rather than throwing: this is a
 * diagnostic gate in front of the real hash check, so it must never convert a
 * bad lock into a worse error than the hash comparison already gives.
 */
async function readLockCompileSchemaVersion(
  kiciDir: string,
  sourceFile: string,
): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsPromises.readFile(path.join(kiciDir, 'kici.lock.json'), 'utf-8'));
  } catch {
    return null;
  }
  const workflows = (parsed as { workflows?: unknown })?.workflows;
  if (!Array.isArray(workflows)) return null;

  // Match the entry by its recorded source file where possible. `sourceFile` is
  // workDir-relative (`.kici/workflows/w.ts`) and so is `source.file`, but a
  // lock written elsewhere can spell it differently — so fall back to any entry
  // that names a version. Every workflow in one lock is compiled by one
  // compiler, so the fallback cannot pick a different answer than the match.
  const normalize = (p: string): string => p.replaceAll('\\', '/').replace(/^\.\//, '');
  const target = normalize(sourceFile);
  const versionOf = (w: unknown): number | null => {
    const v = (w as { compileSchemaVersion?: unknown })?.compileSchemaVersion;
    // 0 is the compiler's "no bundle, no hash" sentinel (generator.ts) — such a
    // lock carries no contentHash to gate, so it is not a version claim.
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  };

  for (const w of workflows) {
    const file = (w as { source?: { file?: unknown } })?.source?.file;
    if (typeof file === 'string' && normalize(file) === target) return versionOf(w);
  }
  for (const w of workflows) {
    const v = versionOf(w);
    if (v !== null) return v;
  }
  return null;
}

async function buildAssetDigestFromResolvedPaths(
  workDir: string,
  resolvedPaths: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const rel of resolvedPaths) {
    const abs = path.join(workDir, rel);
    try {
      const content = await fsPromises.readFile(abs, 'utf-8');
      parts.push(`${rel}\n${content}`);
    } catch {
      parts.push(`${rel}\n`);
    }
  }
  return parts.join('');
}

/**
 * Load a workflow module by dynamic-importing its source file.
 *
 * Registers the oxc-transform loader hook (idempotent), then dynamic-imports
 * the `.ts` file. Transitive imports resolve against the workspace's
 * `node_modules/` the same way any `tsx`-style runner would — so host-repo
 * helpers and `@kici-dev/sdk` Just Work.
 *
 * When `expectedContentHash` is provided, verifies the extracted `.kici/` tree
 * matches the hash in the lock file. It re-hashes the whole tree, not the entry
 * file alone, so an edit to an imported helper is caught — that was the gap
 * that let a warm cache restore a stale tarball and run the OLD helper green.
 * Drift produces a descriptive error that surfaces the baked agent SDK
 * fingerprint (useful when debugging "is the agent running a stale build?").
 */
export async function loadWorkflowSource(
  workDir: string,
  sourceFile: string,
  expectedContentHash?: string,
  resolvedHashFiles?: string[],
): Promise<{ module: Record<string, unknown>; sdkSetters: SdkOutputSetters }> {
  ensureLoaderHookRegistered();

  const filePath = path.join(workDir, sourceFile);

  if (expectedContentHash) {
    // The same walk the compiler ran, over the tree the agent actually has.
    // Falls back to the entry file for a workflow outside a `.kici/` directory,
    // mirroring the compiler's own fallback so the two agree in both shapes.
    const kiciDir = findKiciDir(filePath);

    // The producing compiler's schema version is mixed into `contentHash`, so a
    // compiler and an agent on different versions can NEVER agree — the hash
    // check below would report "workflow source changed" and tell the operator
    // to run `kici compile`, which cannot fix a version mismatch. Read the
    // version the lock records and name the real fault first.
    if (kiciDir) {
      const lockVersion = await readLockCompileSchemaVersion(kiciDir, sourceFile);
      if (lockVersion !== null && lockVersion !== COMPILE_SCHEMA_VERSION) {
        throw new Error(
          `kici.lock.json was compiled by an incompatible @kici-dev/compiler: ` +
            `the lock declares compile schema ${lockVersion}, this agent implements ` +
            `${COMPILE_SCHEMA_VERSION}. The schema version is mixed into every ` +
            `contentHash, so recompiling cannot reconcile them. Align the versions: ` +
            `upgrade the agent to one implementing schema ${lockVersion}, or pin ` +
            `@kici-dev/compiler to a release implementing schema ` +
            `${COMPILE_SCHEMA_VERSION} and recompile ` +
            `(agent baked @kici-dev/sdk@${AGENT_SDK_VERSION} bundleHash=${AGENT_SDK_BUNDLE_HASH}).`,
        );
      }
    }

    const treeDigest = kiciDir ? await hashKiciSourceTree(kiciDir) : '';
    const rawSource = treeDigest || (await fsPromises.readFile(filePath, 'utf-8'));
    let assetDigest: string | undefined;
    if (resolvedHashFiles?.length) {
      assetDigest = await buildAssetDigestFromResolvedPaths(workDir, resolvedHashFiles);
    }
    const actualHash = computeContentHash(rawSource, assetDigest);
    if (actualHash !== expectedContentHash) {
      // A symlink in the hashed tree is the one drift "run kici compile" cannot
      // resolve: the digest covers the link string, so a link the tarball omits
      // or extraction rewrites makes the compiling machine's hash unreachable
      // here and every recompile reproduces it. Name the links when there are
      // any, so the loop is diagnosable from the error alone.
      const symlinkNote = kiciDir
        ? hashedSymlinkDriftNote(await collectSourceSymlinks(kiciDir))
        : '';
      throw new Error(
        `Lock file is out of date: workflow source changed without regenerating kici.lock.json ` +
          `(expected contentHash ${expectedContentHash}, got ${actualHash}, ` +
          `agent baked @kici-dev/sdk@${AGENT_SDK_VERSION} bundleHash=${AGENT_SDK_BUNDLE_HASH}). ` +
          `Run 'kici compile' and commit the updated lock file.${symlinkNote}`,
      );
    }
  }

  const moduleUrl = pathToFileURL(filePath).href;
  const cacheBuster = `?t=${Date.now()}`;
  const module = await import(moduleUrl + cacheBuster);

  const sdkSetters = await resolveWorkflowSdkSetters(filePath);

  return { module: module as Record<string, unknown>, sdkSetters };
}

/**
 * Type guard for Workflow shape (discriminant: `_tag === 'Workflow'`).
 */
function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag: string })._tag === 'Workflow'
  );
}

/**
 * Extract a workflow by name from a module's exports.
 *
 * Searches:
 * 1. Default export (single Workflow or array of Workflows)
 * 2. Named exports
 */
export function extractWorkflow(module: Record<string, unknown>, workflowName: string): Workflow {
  if (module.default) {
    const defaultExport = module.default;

    if (isWorkflow(defaultExport) && defaultExport.name === workflowName) {
      return defaultExport;
    }

    if (Array.isArray(defaultExport)) {
      const found = defaultExport.find(
        (item: unknown) => isWorkflow(item) && item.name === workflowName,
      );
      if (found) return found as Workflow;
    }
  }

  for (const [, value] of Object.entries(module)) {
    if (isWorkflow(value) && value.name === workflowName) {
      return value;
    }
  }

  throw new Error(`Workflow '${workflowName}' not found in module exports`);
}

/**
 * Extract a dynamic job function from a workflow by index.
 */
export function extractDynamicJobFn(workflow: Workflow, index: number): DynamicJobFn {
  if (index < 0 || index >= workflow.jobs.length) {
    throw new Error(
      `Job index ${index} out of bounds (workflow '${workflow.name}' has ${workflow.jobs.length} jobs)`,
    );
  }

  const item = workflow.jobs[index];
  if (!isDynamicJobFn(item)) {
    throw new Error(`Job at index ${index} in workflow '${workflow.name}' is not a dynamic job fn`);
  }

  return item;
}

/**
 * Extract steps from a static job within a workflow.
 */
export function extractSteps(workflow: Workflow, jobName: string): readonly StepInput[] {
  for (const item of workflow.jobs) {
    if (!isDynamicJobFn(item) && (item as Job).name === jobName) {
      return (item as Job).steps;
    }
  }

  throw new Error(`Static job '${jobName}' not found in workflow '${workflow.name}'`);
}

/**
 * Extract steps from a job generated by a DynamicJobFn.
 *
 * Re-evaluates the DynamicJobFn to get the generated Job[] array, then finds
 * the job by name and returns its steps. This is necessary because
 * DynamicJobFn-generated jobs' step functions are closures that can only be
 * obtained by calling the DynamicJobFn again.
 *
 * The function must be deterministic: given the same event context, it should
 * return the same jobs with the same step functions. When `expectedJobNames`
 * is provided, the re-evaluated output is compared against the original eval.
 * A sibling mismatch logs a warning; a missing target job throws a clear
 * determinism error.
 */
export async function extractStepsFromDynamicJob(
  workflow: Workflow,
  dynamicIndex: number,
  jobName: string,
  event: Record<string, unknown>,
  env: Record<string, string | undefined>,
  apiTransport?: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  expectedJobNames?: string[],
  /** Frozen upstream snapshot for a result-aware generator (rebuilds ctx.needs). */
  upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot,
  /** Declared upstream needs that shape ctx.needs. */
  declaredNeeds?: readonly unknown[],
  /**
   * The source / workflow repo pair for a global workflow. Must match what the
   * first evaluation saw, or a generator that reads the source tree produces a
   * different job list here and the determinism check below fails the job.
   */
  repos?: GeneratorRepoPair,
): Promise<{ steps: readonly StepInput[]; droppedJobs: string[] }> {
  const dynamicFn = extractDynamicJobFn(workflow, dynamicIndex);

  const { $ } = await import('zx');
  const { createLogger } = await import('@kici-dev/shared');
  const { buildKiciApi, buildNeedsContext } = await import('@kici-dev/sdk');
  const log = createLogger({ prefix: `dynamic-job-fn:${workflow.name}` });

  const kici = buildKiciApi(
    apiTransport ??
      (() => Promise.reject(new Error('Agent API not available during re-evaluation'))),
  );

  // Rebuild ctx.needs from the frozen snapshot (never a live read), so re-eval
  // sees the identical upstream data the original eval did — the same
  // determinism guarantee ctx.event carries.
  const needs = upstreamSnapshot
    ? buildNeedsContext(
        upstreamSnapshot,
        (declaredNeeds ?? []) as ReadonlyArray<import('@kici-dev/sdk').DynamicJobNeed>,
      )
    : undefined;

  // Built through the shared builder so this re-evaluation and the first
  // evaluation (job-runner.ts, or the global eval round) cannot drift apart.
  const generatedJobs = await dynamicFn(
    buildGeneratorContext({
      workflowName: workflow.name,
      event,
      env,
      ...(repos && { repos }),
      ...(needs && { needs }),
      $,
      log,
      kici,
    }),
  );

  const actualNames = generatedJobs.map((j) => (j as Job).name);

  let droppedJobs: string[] = [];

  if (expectedJobNames) {
    const expectedSet = new Set(expectedJobNames);
    const actualSet = new Set(actualNames);
    const missing = expectedJobNames.filter((n) => !actualSet.has(n));
    const extra = actualNames.filter((n) => !expectedSet.has(n));

    droppedJobs = missing.filter((n) => n !== jobName);

    if (missing.length > 0 || extra.length > 0) {
      const detail =
        (missing.length > 0 ? `missing: [${missing.join(', ')}]` : '') +
        (missing.length > 0 && extra.length > 0 ? '; ' : '') +
        (extra.length > 0 ? `unexpected: [${extra.join(', ')}]` : '');

      if (missing.includes(jobName)) {
        throw new Error(
          `DynamicJobFn non-deterministic re-evaluation: job '${jobName}' no longer exists ` +
            `(workflow '${workflow.name}', index ${dynamicIndex}). ` +
            `Original eval produced: [${expectedJobNames.join(', ')}], ` +
            `re-eval produced: [${actualNames.join(', ')}]. ` +
            `DynamicJobFn must return the same jobs given the same event context. ` +
            `See docs/architecture/dynamic-jobs.md for guidance.`,
        );
      }

      log.warn(
        `DynamicJobFn non-deterministic re-evaluation detected ` +
          `(workflow '${workflow.name}', index ${dynamicIndex}): ${detail}. ` +
          `Target job '${jobName}' still exists — proceeding. ` +
          `DynamicJobFn should return the same jobs given the same event context.`,
      );
    }
  }

  for (const genJob of generatedJobs) {
    if ((genJob as Job).name === jobName) {
      return { steps: (genJob as Job).steps, droppedJobs };
    }
  }

  throw new Error(
    `Generated job '${jobName}' not found in DynamicJobFn output ` +
      `(workflow '${workflow.name}', index ${dynamicIndex}). ` +
      `Available: ${actualNames.join(', ')}`,
  );
}
