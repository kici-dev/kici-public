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
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

import { normalizeLineEndings, sha256 } from '@kici-dev/shared';
import type { Workflow, Job, StepInput, DynamicJobFn, EventPayload } from '@kici-dev/sdk';
import { isDynamicJobFn } from '@kici-dev/sdk';

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
 * Compile schema version — must match `@kici-dev/compiler` lockfile/hasher.ts.
 * Mixed into the content hash so compilation-approach changes produce different
 * hashes. Bumped 3 → 4 when the artifact model switched from a Rolldown-bundled
 * `.compiled.mjs` to a raw-source tarball consumed by the oxc-transform ESM
 * loader hook. Bumped 4 → 5 when the hash input started normalizing line
 * endings (CRLF → LF) so a Windows agent's checked-out CRLF source matches a
 * Linux compiler's LF source.
 */
export const COMPILE_SCHEMA_VERSION = 5;

/**
 * Register the `@kici-dev/core/ts-loader-hook` oxc-transform ESM loader hook so
 * subsequent dynamic `import()` calls for `.ts` / `.tsx` files transform on the
 * fly. Idempotent at our level via the `hookRegistered` flag; Node also
 * tolerates repeated `register()` calls by stacking layers, but we avoid the
 * noise.
 */
let hookRegistered = false;
export function ensureLoaderHookRegistered(): void {
  if (hookRegistered) return;
  register('@kici-dev/core/ts-loader-hook', import.meta.url);
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
 * When `expectedContentHash` is provided, verifies the raw source matches
 * the hash in the lock file. Drift between source and lock file produces a
 * descriptive error that surfaces the baked agent SDK fingerprint (useful
 * when debugging "is the agent running a stale build?").
 */
export async function loadWorkflowSource(
  workDir: string,
  sourceFile: string,
  expectedContentHash?: string,
  resolvedHashFiles?: string[],
): Promise<{ module: Record<string, unknown> }> {
  ensureLoaderHookRegistered();

  const filePath = path.join(workDir, sourceFile);

  if (expectedContentHash) {
    const rawSource = await fsPromises.readFile(filePath, 'utf-8');
    let assetDigest: string | undefined;
    if (resolvedHashFiles?.length) {
      assetDigest = await buildAssetDigestFromResolvedPaths(workDir, resolvedHashFiles);
    }
    const actualHash = computeContentHash(rawSource, assetDigest);
    if (actualHash !== expectedContentHash) {
      throw new Error(
        `Lock file is out of date: workflow source changed without regenerating kici.lock.json ` +
          `(expected contentHash ${expectedContentHash}, got ${actualHash}, ` +
          `agent baked @kici-dev/sdk@${AGENT_SDK_VERSION} bundleHash=${AGENT_SDK_BUNDLE_HASH}). ` +
          `Run 'kici compile' and commit the updated lock file.`,
      );
    }
  }

  const moduleUrl = pathToFileURL(filePath).href;
  const cacheBuster = `?t=${Date.now()}`;
  const module = await import(moduleUrl + cacheBuster);

  return { module: module as Record<string, unknown> };
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

  const generatedJobs = await dynamicFn({
    $,
    // Boundary cast: the wire `event` is untyped JSON that, per the unified
    // event protocol, always carries the normalized event envelope. This is
    // where it enters the DynamicJobFn's user context for re-evaluation.
    ctx: {
      workflow: { name: workflow.name },
      event: event as EventPayload,
      ...(needs && { needs }),
    },
    log,
    env,
    kici,
  });

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
