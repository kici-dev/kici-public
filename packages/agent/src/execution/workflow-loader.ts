/**
 * Imports `.ts` workflow files straight from the cloned / extracted source tree
 * through the `@kici-dev/core/ts-loader-hook` oxc-transform loader hook — no
 * bundle, no Rolldown step at runtime. `@kici-dev/sdk` and host-repo deps
 * resolve by Node's ESM lookup against `.kici/node_modules/`.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { normalizeLineEndings, sha256, toErrorMessage } from '@kici-dev/shared';
import {
  COMPILE_SCHEMA_VERSION,
  collectSourceSymlinks,
  findKiciDir,
  hashKiciSourceTree,
  hashedSymlinkDriftNote,
} from '@kici-dev/core/kici-source-digest';
import type { Workflow, Job, StepInput, DynamicJobFn, OutputsMap, StepRefMap } from '@kici-dev/sdk';
import { isDynamicJobFn } from '@kici-dev/sdk';
import { buildGeneratorContext, type GeneratorRepoPair } from './generator-context.js';

/**
 * Output-map setters of the workflow module's OWN SDK copy (not the agent's
 * bundled SDK), wired to the maps the step loop mutates so within-job `.result`
 * proxies — reading that copy's module-global `_stepOutputsMap` — resolve.
 */
export interface SdkOutputSetters {
  setStepOutputsMap: (map: OutputsMap) => void;
  setStepRefMap: (map: StepRefMap) => void;
  setJobOutputsMap: (map: OutputsMap) => void;
}

/**
 * Resolves the `@kici-dev/sdk` instance the workflow module itself imports.
 *
 * `createRequire(workflowFilePath)` walks `node_modules` exactly as the
 * workflow's own `import '@kici-dev/sdk'` does, hoisted copies included, and
 * Node caches ESM by resolved URL, so the setters mutate the live map the
 * proxies read.
 *
 * The setters live only on `@kici-dev/sdk/internal`. Without that subpath the
 * agent's bundled setters would mutate a map the proxies never read, so the
 * mismatch is refused here rather than surfacing as an empty `.result`.
 */
export async function resolveWorkflowSdkSetters(
  workflowFilePath: string,
): Promise<SdkOutputSetters> {
  const req = createRequire(workflowFilePath);
  let sdk: Partial<SdkOutputSetters>;
  try {
    const sdkEntry = req.resolve('@kici-dev/sdk/internal');
    sdk = (await import(pathToFileURL(sdkEntry).href)) as Partial<SdkOutputSetters>;
  } catch (err) {
    throw new Error(
      `Could not resolve @kici-dev/sdk/internal from ${workflowFilePath}: the workflow tree ` +
        `must depend on @kici-dev/sdk@>=0.8.0 to run on this agent ` +
        `(agent baked @kici-dev/sdk@${AGENT_SDK_VERSION}). ` +
        `Upgrade the repository's @kici-dev/sdk and recompile: ${toErrorMessage(err)}`,
    );
  }
  if (
    typeof sdk.setStepOutputsMap !== 'function' ||
    typeof sdk.setStepRefMap !== 'function' ||
    typeof sdk.setJobOutputsMap !== 'function'
  ) {
    throw new Error(
      `@kici-dev/sdk/internal resolved from ${workflowFilePath} carries no output-map setters; ` +
        `the workflow tree must depend on @kici-dev/sdk@>=0.8.0 to run on this agent ` +
        `(agent baked @kici-dev/sdk@${AGENT_SDK_VERSION}).`,
    );
  }
  return {
    setStepOutputsMap: sdk.setStepOutputsMap,
    setStepRefMap: sdk.setStepRefMap,
    setJobOutputsMap: sdk.setJobOutputsMap,
  };
}

// Injected by the agent bundler (scripts/build-service.mjs). The lock-file drift
// error carries this baked SDK fingerprint so an operator can compare it with
// the host / orchestrator one without tailing the agent startup log.
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
const AGENT_SDK_VERSION = typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown';
const AGENT_SDK_BUNDLE_HASH =
  typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown';

/**
 * Re-exported, never copied: the compiler mixes this constant into every
 * `contentHash`, so a second copy would let producer and verifier drift apart.
 */
export { COMPILE_SCHEMA_VERSION } from '@kici-dev/core/kici-source-digest';

/**
 * Registers the `.ts` / `.tsx` loader hook once (Node would stack repeated
 * `register()` calls as layers).
 *
 * - **Container** — `KICI_TS_LOADER_HOOK_PATH` (set only by `ContainerSandbox`)
 *   names a pure-JS hook bundle mounted into the job container, registered by
 *   absolute `file://` URL: `module.register` resolves a bare specifier on disk
 *   in a worker thread, and a bare customer container has no `node_modules`
 *   next to the runner bundle.
 * - **Fork / firecracker** — the bare `@kici-dev/core/ts-loader-hook`
 *   specifier, resolved from the workspace `node_modules` those sandboxes bind
 *   read-only.
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
 * The same formula as `@kici-dev/compiler` `lockfile/hasher.ts`, including its
 * LF normalization of `rawSource` and `assetDigest`, so a Windows agent (Git's
 * `core.autocrlf=true` default checks out CRLF) agrees with a lock compiled on
 * Linux.
 */
function computeContentHash(rawSource: string, assetDigest?: string): string {
  let input = `${COMPILE_SCHEMA_VERSION}:${normalizeLineEndings(rawSource)}`;
  if (assetDigest !== undefined && assetDigest.length > 0) {
    input += `\0${normalizeLineEndings(assetDigest)}`;
  }
  return sha256(input);
}

/**
 * The compile schema version the lock records for `sourceFile`, or null when
 * the tree has no readable lock (a `file://` in-place run, a workflow outside
 * `.kici/`, a hand-built fixture).
 *
 * `source-packer.ts` packs `.kici/kici.lock.json` (the digest excludes it), so
 * no wire field is needed. A malformed lock returns null, never throws: this
 * diagnostic gate must not turn a bad lock into a worse error than the hash
 * check gives.
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

  // Both paths are workDir-relative, but a lock written elsewhere can spell
  // `source.file` differently, so fall back to any entry naming a version: one
  // compiler compiles every workflow in a lock, so the answer is the same.
  const normalize = (p: string): string => p.replaceAll('\\', '/').replace(/^\.\//, '');
  const target = normalize(sourceFile);
  const versionOf = (w: unknown): number | null => {
    const v = (w as { compileSchemaVersion?: unknown })?.compileSchemaVersion;
    // 0 is the compiler's "no bundle, no hash" sentinel (generator.ts), not a
    // version claim.
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
 * Dynamic-imports the workflow's `.ts` file; transitive imports resolve against
 * the workspace `node_modules/` as under any `tsx`-style runner.
 *
 * With `expectedContentHash`, re-hashes the whole extracted `.kici/` tree, not
 * just the entry file, so a warm cache restoring a stale tarball cannot run an
 * old imported helper green. The drift error names the baked agent SDK
 * fingerprint, to spot an agent running a stale build.
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
    // The compiler's walk; outside a `.kici/` directory both fall back to the
    // entry file.
    const kiciDir = findKiciDir(filePath);

    // The schema version is mixed into `contentHash`, so mismatched versions
    // never agree, and the hash error would wrongly advise `kici compile`.
    // Name the real fault first.
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
      // A symlink is the one drift recompiling cannot fix: the digest covers the
      // link string, so a link the tarball omits or extraction rewrites makes
      // the hash unreachable here on every recompile. Name the links.
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

function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag: string })._tag === 'Workflow'
  );
}

/** Searches the default export (one Workflow or an array), then named exports. */
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

export function extractSteps(workflow: Workflow, jobName: string): readonly StepInput[] {
  for (const item of workflow.jobs) {
    if (!isDynamicJobFn(item) && (item as Job).name === jobName) {
      return (item as Job).steps;
    }
  }

  throw new Error(`Static job '${jobName}' not found in workflow '${workflow.name}'`);
}

/**
 * Re-evaluates the DynamicJobFn, because generated step functions are closures
 * obtainable only by calling it again, and returns the named job's steps.
 *
 * The function must be deterministic for the same event context. Against
 * `expectedJobNames`, a sibling mismatch logs a warning and a missing target
 * job throws a determinism error.
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
  declaredNeeds?: readonly unknown[],
  /**
   * A global workflow's repo pair; it must match the first evaluation's, or a
   * generator reading the source tree fails the determinism check.
   */
  repos?: GeneratorRepoPair,
): Promise<{ steps: readonly StepInput[]; droppedJobs: string[] }> {
  const dynamicFn = extractDynamicJobFn(workflow, dynamicIndex);

  const { $ } = await import('zx');
  const { createLogger } = await import('@kici-dev/shared');
  const { buildKiciApi, buildNeedsContext } = await import('@kici-dev/sdk/internal');
  const log = createLogger({ prefix: `dynamic-job-fn:${workflow.name}` });

  const kici = buildKiciApi(
    apiTransport ??
      (() => Promise.reject(new Error('Agent API not available during re-evaluation'))),
  );

  // From the frozen snapshot, never a live read, so re-eval sees the original
  // upstream data (the guarantee ctx.event carries).
  const needs = upstreamSnapshot
    ? buildNeedsContext(
        upstreamSnapshot,
        (declaredNeeds ?? []) as ReadonlyArray<import('@kici-dev/sdk').DynamicJobNeed>,
      )
    : undefined;

  // The shared builder keeps this and the first evaluation (job-runner.ts, or
  // the global eval round) from drifting apart.
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
