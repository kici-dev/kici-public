import { sha256 } from '@kici-dev/core';
import {
  PackageManager,
  detectPackageManagerSync,
  detectYarnFlavorSync,
} from '@kici-dev/core/package-manager';
import {
  validateResourceRequest,
  resolveWhenToRunOn,
  extractInputsDescriptorMap,
  assertScheduleInputsSatisfiable,
} from '@kici-dev/engine';
import type { LabelMatcher, RunsOnPick } from '@kici-dev/engine';
import type { NeedsWhenInput } from '@kici-dev/sdk';
import {
  normalizeRunsOnToMatchers,
  normalizeRunsOnAllToMatchers,
  runsOnPickFromInput,
} from '@kici-dev/engine/labels/compile';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Workflow,
  Job,
  Step,
  StepInput,
  ParallelGroup,
  TriggerConfig,
  Rule,
  JobOrFactory,
  Matrix,
  RunsOn,
} from '@kici-dev/sdk';
import {
  isDynamicJobFn,
  isStaticArray,
  isStaticObject,
  isDynamicFunction,
  isDynamicGroupRef,
  getDynamicJobGroup,
  getDynamicJobNeeds,
  normalizeCacheSpecs,
  normalizeApproval,
  isParallelGroup,
} from '@kici-dev/sdk';
import type { ApprovalConfig } from '@kici-dev/sdk';
import {
  SCHEMA_VERSION,
  type LockFile,
  type LockSource,
  type LockWorkflow,
  type LockJob,
  type LockDynamicJobFn,
  type LockJobOrFactory,
  type LockInlineValue,
  type LockTrigger,
  type LockPrTrigger,
  type LockPushTrigger,
  type LockTagTrigger,
  type LockCommentTrigger,
  type LockReviewTrigger,
  type LockReviewCommentTrigger,
  type LockReleaseTrigger,
  type LockDispatchTrigger,
  type LockCreateTrigger,
  type LockDeleteTrigger,
  type LockStatusTrigger,
  type LockWorkflowRunTrigger,
  type LockForkTrigger,
  type LockStarTrigger,
  type LockWatchTrigger,
  type LockWebhookTrigger,
  type LockKiciEventTrigger,
  type LockWorkflowCompleteTrigger,
  type LockJobCompleteTrigger,
  type LockGenericWebhookTrigger,
  type LockScheduleTrigger,
  type LockLifecycleTrigger,
  type LockMatrix,
  type LockRule,
  type LockStep,
  type LockParallelStep,
  type LockStepEntry,
  type LockApproval,
  type LockBranchPattern,
  type WorkflowWithSource,
  type WorkflowSourceInfo,
} from '../types.js';
import { computeContentHash, COMPILE_SCHEMA_VERSION } from './hasher.js';
import { resolveHashFiles } from './hash-files.js';
import { analyzePurity } from './purity-analyzer.js';

/**
 * Detect git repository root by running `git rev-parse --show-toplevel`.
 * Falls back to cwd if not in a git repo.
 *
 * @returns Absolute path to git root, or cwd if not in git repo
 */
export function detectGitRoot(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return gitRoot;
  } catch {
    // Not in a git repo, fall back to cwd
    return process.cwd();
  }
}

/**
 * Compute the dependency-cache key: a SHA-256 hash of the repo's lockfile,
 * scoped to the detected package manager.
 *
 * The authoritative lockfile differs by manager: `.kici/package-lock.json` for
 * npm, the repo-root `pnpm-lock.yaml` for a pnpm workspace, the repo-root
 * `yarn.lock` for a yarn workspace. A pnpm/yarn `.kici/` member resolves against
 * the root lockfile, so keying on `.kici/package-lock.json` alone would miss the
 * authoritative graph. A standalone `.kici` yarn project (its own
 * `packageManager` field + `.kici/yarn.lock`, no root signal) is detected from
 * `.kici/` and keyed on `.kici/yarn.lock`. The hash input is prefixed with the
 * manager name so two managers can never collide on identical lockfile bytes
 * (and a restored tree can never be the wrong layout for the agent's manager).
 * For yarn the prefix also carries the flavor (`yarn-classic` / `yarn-berry`),
 * so a classic-layout dep-cache tarball is never restored into a berry install.
 *
 * @param gitRoot - Absolute path to git repository root
 * @returns Hex SHA-256 hash string, or null if no lockfile is found
 */
export function computeLockfileHash(gitRoot: string): string | null {
  // Detect from the repo root first; fall back to `.kici/` so a standalone
  // `.kici` project (its own packageManager field + lockfile, no root signal)
  // is still keyed on the right manager + lockfile.
  const pm =
    detectPackageManagerSync(gitRoot) === PackageManager.Npm
      ? detectPackageManagerSync(path.join(gitRoot, '.kici'))
      : detectPackageManagerSync(gitRoot);

  const candidates: string[] =
    pm === PackageManager.Pnpm
      ? [path.join(gitRoot, 'pnpm-lock.yaml'), path.join(gitRoot, '.kici', 'pnpm-lock.yaml')]
      : pm === PackageManager.Yarn
        ? [path.join(gitRoot, 'yarn.lock'), path.join(gitRoot, '.kici', 'yarn.lock')]
        : [path.join(gitRoot, '.kici', 'package-lock.json')];

  // For yarn, fold the flavor (classic vs berry) into the prefix so a
  // classic-layout tarball is never restored into a berry install (and vice
  // versa), even on the practically-impossible identical-bytes case. Probe the
  // dir that carried the yarn signal — same root-then-`.kici` precedence as pm.
  const prefix =
    pm === PackageManager.Yarn
      ? `${pm}-${detectYarnFlavorSync(
          detectPackageManagerSync(gitRoot) === PackageManager.Yarn
            ? gitRoot
            : path.join(gitRoot, '.kici'),
        )}`
      : pm;

  for (const lockfilePath of candidates) {
    try {
      const content = readFileSync(lockfilePath, 'utf-8');
      return sha256(`${prefix}\n${content}`);
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Format export reference with hash syntax.
 * Examples:
 * - #build (named export)
 * - #default (single default export)
 * - #default[0] (first item in default array)
 *
 * @param source - Workflow source info
 * @returns Export reference string with hash prefix
 */
function formatExportRef(source: WorkflowSourceInfo): string {
  if (source.arrayIndex !== undefined) {
    return `#${source.exportName}[${source.arrayIndex}]`;
  }
  return `#${source.exportName}`;
}

/**
 * Generate a lock file from validated workflows with source tracking.
 *
 * @param workflowsWithSource - Validated workflows with source info
 * @returns Lock file ready for JSON serialization
 */
export function generateLockFile(workflowsWithSource: WorkflowWithSource[]): LockFile {
  const gitRoot = detectGitRoot();
  const lockfileHash = computeLockfileHash(gitRoot);

  // For the top-level source, use the first workflow's source
  // (typically all workflows come from files in the same .kici/workflows/ directory)
  const firstSource = workflowsWithSource[0]?.source;
  const topLevelSource: LockSource = firstSource
    ? {
        file: path.relative(gitRoot, firstSource.file).replaceAll('\\', '/'),
        export: formatExportRef(firstSource),
      }
    : {
        file: '.kici/workflows',
        export: '#default',
      };

  const workflows = workflowsWithSource.map(({ workflow, source, bundleSource }) => {
    const relativeFile = path.relative(gitRoot, source.file).replaceAll('\\', '/');
    return transformWorkflow(
      workflow,
      relativeFile,
      formatExportRef(source),
      bundleSource,
      gitRoot,
    );
  });

  // Compute top-level content hash from the full lock file content (excluding the hash itself).
  // This hash changes only when workflows, triggers, jobs, or bundle hashes change.
  const partial = { schemaVersion: SCHEMA_VERSION, source: topLevelSource, workflows };
  const contentHash = sha256(JSON.stringify(partial));

  return {
    schemaVersion: SCHEMA_VERSION,
    source: topLevelSource,
    contentHash,
    ...(lockfileHash && { lockfileHash }),
    workflows,
  };
}

/**
 * Transform SDK Workflow to lock file format.
 *
 * @param workflow - The workflow definition
 * @param sourceFile - Relative path to source file (from git root)
 * @param exportRef - Export reference (e.g., #build, #default[0])
 * @param bundleSource - Compiled JS bundle for content hashing
 * @param gitRoot - Git repository root for resolving hashFiles
 */
function transformWorkflow(
  workflow: Workflow,
  sourceFile: string,
  exportRef: string,
  bundleSource: string | undefined,
  gitRoot: string,
): LockWorkflow {
  let assetDigest: string | undefined;
  let resolvedHashFiles: string[] | undefined;
  if (workflow.hashFiles && workflow.hashFiles.length > 0) {
    const resolved = resolveHashFiles(gitRoot, workflow.hashFiles);
    if (resolved) {
      assetDigest = resolved.assetDigest;
      resolvedHashFiles = resolved.resolvedPaths;
    }
  }

  const contentHash =
    bundleSource !== undefined
      ? computeContentHash(bundleSource, COMPILE_SCHEMA_VERSION, assetDigest)
      : '';
  const compileSchemaVersion = bundleSource !== undefined ? COMPILE_SCHEMA_VERSION : 0;

  return {
    name: workflow.name,
    source: {
      file: sourceFile,
      export: exportRef,
    },
    contentHash,
    compileSchemaVersion,
    triggers: transformTriggers(workflow.on),
    jobs: transformJobs(workflow.jobs, sourceFile, gitRoot),
    rules: workflow.rules ? transformRules(workflow.rules, sourceFile) : undefined,
    description: workflow.description,
    ...(workflow.hashFiles?.length && { hashFiles: workflow.hashFiles }),
    ...(resolvedHashFiles?.length && { resolvedHashFiles: resolvedHashFiles }),
    ...(workflow.registries?.length && {
      registries: workflow.registries.map((r) => ({
        url: r.url,
        ...(r.scope !== undefined && { scope: r.scope }),
        tokenSecret: r.tokenSecret,
        ...(r.alwaysAuth !== undefined && { alwaysAuth: r.alwaysAuth }),
      })),
    }),
    ...(workflow.installEnv?.length && { installEnv: [...workflow.installEnv] }),
    ...(workflow.onCancel !== undefined && { hasOnCancel: true }),
    ...(workflow.cleanup !== undefined && { hasCleanup: true }),
    ...(workflow.onSuccess !== undefined && { hasOnSuccess: true }),
    ...(workflow.onFailure !== undefined && { hasOnFailure: true }),
    ...(workflow.concurrency && {
      concurrency: {
        hasGroup: !!workflow.concurrency.group,
        ...(workflow.concurrency.cancelInProgress !== undefined && {
          cancelInProgress: workflow.concurrency.cancelInProgress,
        }),
        ...(workflow.concurrency.max !== undefined && { max: workflow.concurrency.max }),
      },
    }),
    ...(workflow.timeout !== undefined && { timeout: workflow.timeout }),
    ...(workflow.approval !== undefined && {
      approval:
        (assertNonStepApprovalScope(workflow.approval, 'workflow'),
        toLockApproval(workflow.approval)),
    }),
  };
}

type TriggerWithRepos = Extract<TriggerConfig, { repos?: readonly unknown[] }>;

/**
 * Spread fragment that adds a `repos` field only when the SDK trigger
 * actually carries cross-repo patterns. Identical pattern is required by
 * 14 of the 22 trigger transforms below.
 */
function reposField(
  trigger: Pick<TriggerWithRepos, 'repos'>,
): { repos: readonly LockBranchPattern[] } | Record<string, never> {
  return trigger.repos && trigger.repos.length > 0
    ? { repos: transformBranchPatterns(trigger.repos) }
    : {};
}

type ExtractTrigger<Tag extends TriggerConfig['_tag']> = Extract<TriggerConfig, { _tag: Tag }>;

function toLockPr(t: ExtractTrigger<'PrTrigger'>): LockPrTrigger {
  return {
    _type: 'pr',
    events: t.events,
    targetBranches: transformBranchPatterns(t.targetBranches),
    sourceBranches: transformBranchPatterns(t.sourceBranches),
    paths: t.paths,
    ...reposField(t),
  };
}

function toLockPushAndTag(t: ExtractTrigger<'PushTrigger'>): LockTrigger[] {
  const results: LockTrigger[] = [
    {
      _type: 'push',
      branches: transformBranchPatterns(t.branches),
      paths: t.paths,
      ...reposField(t),
    } satisfies LockPushTrigger,
  ];
  // Push triggers with tag patterns also emit a LockTagTrigger.
  if (t.tags.length > 0) {
    results.push({
      _type: 'tag',
      patterns: transformBranchPatterns(t.tags),
    } satisfies LockTagTrigger);
  }
  return results;
}

function toLockTag(t: ExtractTrigger<'TagTrigger'>): LockTagTrigger {
  return {
    _type: 'tag',
    patterns: transformBranchPatterns(t.patterns),
    ...reposField(t),
  };
}

function toLockComment(t: ExtractTrigger<'CommentTrigger'>): LockCommentTrigger {
  return {
    _type: 'comment',
    actions: t.actions,
    source: t.source,
    bodyMatch: t.bodyMatch,
    ...reposField(t),
  };
}

function toLockReview(t: ExtractTrigger<'ReviewTrigger'>): LockReviewTrigger {
  return {
    _type: 'review',
    actions: t.actions,
    states: t.states,
    ...reposField(t),
  };
}

function toLockReviewComment(t: ExtractTrigger<'ReviewCommentTrigger'>): LockReviewCommentTrigger {
  return {
    _type: 'review_comment',
    actions: t.actions,
    ...reposField(t),
  };
}

function toLockRelease(t: ExtractTrigger<'ReleaseTrigger'>): LockReleaseTrigger {
  return {
    _type: 'release',
    actions: t.actions,
    ...reposField(t),
  };
}

function toLockDispatch(t: ExtractTrigger<'DispatchTrigger'>): LockDispatchTrigger {
  return {
    _type: 'dispatch',
    types: t.types,
    ...reposField(t),
    ...(t.inputs && {
      inputs: extractInputsDescriptorMap(t.inputs as Record<string, unknown>),
    }),
  };
}

function toLockCreate(t: ExtractTrigger<'CreateTrigger'>): LockCreateTrigger {
  return {
    _type: 'create',
    refTypes: t.refTypes,
    patterns: transformBranchPatterns(t.patterns),
    ...reposField(t),
  };
}

function toLockDelete(t: ExtractTrigger<'DeleteTrigger'>): LockDeleteTrigger {
  return {
    _type: 'delete',
    refTypes: t.refTypes,
    patterns: transformBranchPatterns(t.patterns),
    ...reposField(t),
  };
}

function toLockStatus(t: ExtractTrigger<'StatusTrigger'>): LockStatusTrigger {
  return {
    _type: 'status',
    contexts: t.contexts,
    states: t.states,
    ...reposField(t),
  };
}

function toLockWorkflowRun(t: ExtractTrigger<'WorkflowRunTrigger'>): LockWorkflowRunTrigger {
  return {
    _type: 'workflow_run',
    actions: t.actions,
    workflows: t.workflows,
    conclusions: t.conclusions,
    ...reposField(t),
  };
}

function toLockFork(t: ExtractTrigger<'ForkTrigger'>): LockForkTrigger {
  return {
    _type: 'fork',
    ...reposField(t),
  };
}

function toLockStar(t: ExtractTrigger<'StarTrigger'>): LockStarTrigger {
  return {
    _type: 'star',
    actions: t.actions,
    ...reposField(t),
  };
}

function toLockWatch(t: ExtractTrigger<'WatchTrigger'>): LockWatchTrigger {
  return {
    _type: 'watch',
    actions: t.actions,
    ...reposField(t),
  };
}

function toLockWebhook(t: ExtractTrigger<'WebhookTrigger'>): LockWebhookTrigger {
  return {
    _type: 'webhook',
    events: t.events,
    actions: t.actions,
    ...reposField(t),
  };
}

function toLockKiciEvent(t: ExtractTrigger<'KiciEventTrigger'>): LockKiciEventTrigger {
  return {
    _type: 'kici_event',
    eventName: t.name,
    ...(t.match !== undefined && { match: t.match }),
    ...(t.not !== undefined && { not: t.not }),
    ...(t.source !== undefined && { source: t.source }),
  };
}

function toLockWorkflowComplete(
  t: ExtractTrigger<'WorkflowCompleteTrigger'>,
): LockWorkflowCompleteTrigger {
  return {
    _type: 'workflow_complete',
    ...(t.name !== undefined && { name: t.name }),
    ...(t.status !== undefined && { status: t.status }),
    ...(t.source !== undefined && { source: t.source }),
  };
}

function toLockJobComplete(t: ExtractTrigger<'JobCompleteTrigger'>): LockJobCompleteTrigger {
  return {
    _type: 'job_complete',
    ...(t.workflow !== undefined && { workflow: t.workflow }),
    ...(t.job !== undefined && { job: t.job }),
    ...(t.status !== undefined && { status: t.status }),
    ...(t.source !== undefined && { source: t.source }),
  };
}

function toLockGenericWebhookAuth(
  auth: NonNullable<ExtractTrigger<'GenericWebhookTrigger'>['auth']>,
): NonNullable<LockGenericWebhookTrigger['auth']> {
  return {
    method: auth.method,
    secret: auth.secret,
    ...(auth.method === 'hmac-sha256' && {
      signatureHeader: (auth as { signatureHeader: string }).signatureHeader,
    }),
    ...(auth.method === 'api-key' &&
      (auth as { header?: string }).header && {
        header: (auth as { header: string }).header,
      }),
  };
}

function toLockGenericWebhook(
  t: ExtractTrigger<'GenericWebhookTrigger'>,
): LockGenericWebhookTrigger {
  return {
    _type: 'generic_webhook',
    source: t.source,
    ...(t.events !== undefined && { events: t.events }),
    ...(t.match !== undefined && { match: t.match }),
    ...(t.not !== undefined && { not: t.not }),
    ...(t.auth !== undefined && { auth: toLockGenericWebhookAuth(t.auth) }),
    ...(t.path !== undefined && { path: t.path }),
  };
}

function toLockSchedule(t: ExtractTrigger<'ScheduleTrigger'>): LockScheduleTrigger {
  const inputs = t.inputs
    ? extractInputsDescriptorMap(t.inputs as Record<string, unknown>)
    : undefined;
  if (inputs) assertScheduleInputsSatisfiable(inputs);
  return {
    _type: 'schedule',
    cronExpression: t.cron,
    timezone: t.timezone,
    ...(t.description && { description: t.description }),
    ...(inputs && { inputs }),
  };
}

function toLockLifecycle(t: ExtractTrigger<'LifecycleTrigger'>): LockLifecycleTrigger {
  return {
    _type: 'lifecycle',
    events: [...t.events],
    ...(t.sources && { sources: [...t.sources] }),
    ...(t.description && { description: t.description }),
  };
}

function transformOneTrigger(trigger: TriggerConfig): LockTrigger[] {
  switch (trigger._tag) {
    case 'PrTrigger':
      return [toLockPr(trigger)];
    case 'PushTrigger':
      return toLockPushAndTag(trigger);
    case 'TagTrigger':
      return [toLockTag(trigger)];
    case 'CommentTrigger':
      return [toLockComment(trigger)];
    case 'ReviewTrigger':
      return [toLockReview(trigger)];
    case 'ReviewCommentTrigger':
      return [toLockReviewComment(trigger)];
    case 'ReleaseTrigger':
      return [toLockRelease(trigger)];
    case 'DispatchTrigger':
      return [toLockDispatch(trigger)];
    case 'CreateTrigger':
      return [toLockCreate(trigger)];
    case 'DeleteTrigger':
      return [toLockDelete(trigger)];
    case 'StatusTrigger':
      return [toLockStatus(trigger)];
    case 'WorkflowRunTrigger':
      return [toLockWorkflowRun(trigger)];
    case 'ForkTrigger':
      return [toLockFork(trigger)];
    case 'StarTrigger':
      return [toLockStar(trigger)];
    case 'WatchTrigger':
      return [toLockWatch(trigger)];
    case 'WebhookTrigger':
      return [toLockWebhook(trigger)];
    case 'KiciEventTrigger':
      return [toLockKiciEvent(trigger)];
    case 'WorkflowCompleteTrigger':
      return [toLockWorkflowComplete(trigger)];
    case 'JobCompleteTrigger':
      return [toLockJobComplete(trigger)];
    case 'GenericWebhookTrigger':
      return [toLockGenericWebhook(trigger)];
    case 'ScheduleTrigger':
      return [toLockSchedule(trigger)];
    case 'LifecycleTrigger':
      return [toLockLifecycle(trigger)];
  }
}

/**
 * Transform trigger configs to lock file format.
 * Uses flatMap because push triggers with tags generate two lock triggers.
 * Exported for reuse in the test runner's in-memory lock format conversion.
 */
export function transformTriggers(triggers?: TriggerConfig[]): readonly LockTrigger[] {
  if (!triggers) return [];
  return triggers.flatMap(transformOneTrigger);
}

/**
 * Transform branch patterns to lock file format.
 */
function transformBranchPatterns(
  patterns: readonly { type: 'glob' | 'regex'; pattern: string; flags?: string }[],
): readonly LockBranchPattern[] {
  return patterns.map((p) => ({
    type: p.type,
    pattern: p.pattern,
    flags: p.flags,
  }));
}

/** UUID v4 pattern: 8-4-4-4-12 hex chars */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transform jobs array (may contain static jobs and dynamic generators).
 * Assigns counter-based IDs to UUID-named jobs (created by id-less job() factory).
 * Counter only increments for unnamed entries; named jobs keep their names.
 *
 * Builds a UUID-to-renamed-name mapping in a pre-pass so that `needs` references
 * to other UUID-named jobs resolve to their lock file names (job-N), not the UUIDs.
 */
function transformJobs(
  jobs: JobOrFactory[],
  configPath: string,
  gitRoot: string,
): readonly LockJobOrFactory[] {
  // Pre-pass: build UUID -> job-N name mapping for resolveNeeds
  let preCounter = 0;
  const uuidToName = new Map<string, string>();
  for (const jobOrFactory of jobs) {
    if (isDynamicJobFn(jobOrFactory)) continue;
    const j = jobOrFactory as Job;
    if (UUID_PATTERN.test(j.name)) {
      uuidToName.set(j.name, `job-${++preCounter}`);
    }
  }

  let jobCounter = 0;
  return jobs.map((jobOrFactory, index): LockJobOrFactory => {
    if (isDynamicJobFn(jobOrFactory)) {
      // Dynamic job generator - can't serialize, store reference
      const groupName = getDynamicJobGroup(jobOrFactory);
      const declaredNeeds = getDynamicJobNeeds(jobOrFactory);
      // Result-aware generators declare upstream needs via the options-object
      // form. Normalize them with the same helper the static-job `needs`
      // serialization uses so the deferred eval job is gated identically.
      const resolvedNeeds = declaredNeeds
        ? resolveNeedsForLock(declaredNeeds as Job['needs'], uuidToName)
        : undefined;
      return {
        _type: 'dynamic',
        source: {
          file: configPath,
          index,
        },
        ...(groupName && { group: groupName }),
        ...(resolvedNeeds && {
          needs: resolvedNeeds.needs,
          resultAware: true,
        }),
      } satisfies LockDynamicJobFn;
    }

    // Static job - detect UUID name (auto-generated by id-less job() factory)
    const j = jobOrFactory as Job;
    const isUuid = UUID_PATTERN.test(j.name);
    const name = isUuid ? `job-${++jobCounter}` : j.name;
    return transformJob({ ...j, name } as Job, configPath, index, gitRoot, uuidToName);
  });
}

/**
 * Normalize SDK runsOn into lock file matchers.
 * Plain strings stay exact; globs convert to regex; RegExp literals become regex.
 * Throws (via the engine ReDoS gate) on a ReDoS-prone author regex.
 */
function normalizeRunsOnForLock(
  runsOn: RunsOn,
  jobName: string,
): { runsOn: LabelMatcher[]; excludeLabels?: LabelMatcher[]; runsOnPick: RunsOnPick } {
  const { include, exclude } = normalizeRunsOnToMatchers(
    runsOn as never,
    `job '${jobName}' runsOn`,
  );
  return {
    runsOn: include,
    ...(exclude.length > 0 ? { excludeLabels: exclude } : {}),
    runsOnPick: runsOnPickFromInput(runsOn as never),
  };
}

/**
 * Validate runsOn labels: reject overlap between required and excluded labels.
 *
 * `kici:` labels ARE valid runsOn selectors. runsOn expresses a requirement on
 * candidate agents — it only narrows the set, it never grants authority — so
 * targeting a `kici:os:linux` / `kici:role:builder` label is benign. The forgery
 * boundary is label *setting* (scaler labelSet validation + the agent
 * register-time scope gate), which is enforced elsewhere and unaffected here.
 *
 * The overlap check compares exact matchers only — a glob/regex include and an
 * exact exclude (or vice versa) cannot be statically known to overlap.
 */
function validateRunsOn(runsOn: RunsOn, jobName: string): void {
  const { include, exclude } = normalizeRunsOnToMatchers(
    runsOn as never,
    `job '${jobName}' runsOn`,
  );
  const includeExact = new Set(
    include.filter((m) => m.kind === 'exact').map((m) => (m as { value: string }).value),
  );
  const overlap = exclude
    .filter((m) => m.kind === 'exact')
    .map((m) => (m as { value: string }).value)
    .filter((v) => includeExact.has(v));
  if (overlap.length > 0) {
    throw new Error(
      `Job "${jobName}": labels and exclude overlap on [${overlap.join(', ')}]. A label cannot be both required and excluded.`,
    );
  }
}

/**
 * Transform one environment reference (static name or function) into a lock
 * `{ value, dynamic }` entry. A function element is analyzed for purity: a pure
 * function becomes an inline expression resolvable at two-phase eval; an impure
 * one carries only the `dynamic` flag (the agent runs an init job to resolve it).
 */
function transformEnvironmentRef(
  ref: NonNullable<Job['environments']>[number],
  jobName: string,
): { value: string | LockInlineValue; dynamic: boolean } {
  if (typeof ref === 'function') {
    const fnSource = ref.toString();
    const purity = analyzePurity(fnSource);
    if (purity.pure) {
      return { value: { _type: 'inline', expression: fnSource }, dynamic: true };
    }
    console.warn(
      `[kici] Job "${jobName}": environment function is not pure (${purity.reason}). ` +
        'An init job will be required, adding ~5-10s delay.',
    );
    return { value: '', dynamic: true };
  }
  return { value: ref, dynamic: false };
}

/**
 * Transform a static job to lock file format.
 */
function transformJob(
  job: Job,
  configPath: string,
  index: number,
  gitRoot: string,
  uuidToName?: Map<string, string>,
): LockJob {
  // runsOn and runsOnAll are mutually exclusive; exactly one must be present.
  if (job.runsOn !== undefined && job.runsOnAll !== undefined) {
    throw new Error(`job '${job.name}': runsOn and runsOnAll are mutually exclusive`);
  }
  if (job.runsOn === undefined && job.runsOnAll === undefined) {
    throw new Error(`job '${job.name}': one of runsOn or runsOnAll is required`);
  }
  if (job.onUnreachable !== undefined && job.runsOnAll === undefined) {
    console.warn(`[kici] job '${job.name}': onUnreachable is ignored without runsOnAll`);
  }
  // Fan-out concurrency: maxParallel must be >= 1, and both maxParallel/failFast
  // are only meaningful on a fan-out job (matrix or runsOnAll).
  if (job.maxParallel !== undefined && job.maxParallel < 1) {
    throw new Error(`job '${job.name}': maxParallel must be >= 1`);
  }
  const hasFanout = job.matrix !== undefined || job.runsOnAll !== undefined;
  if (!hasFanout && (job.maxParallel !== undefined || job.failFast !== undefined)) {
    console.warn(
      `[kici] job '${job.name}': maxParallel/failFast are ignored without matrix or runsOnAll (no fan-out to bound)`,
    );
  }
  // Validate runsOn for overlap between required and excluded labels
  if (job.runsOn !== undefined) validateRunsOn(job.runsOn, job.name);

  // Resolve environments into an ordered array of { value, dynamic } entries.
  // Either spelling normalizes here: `environment: 'x'` becomes a one-element
  // array; `environments: [...]` is emitted in order. Each function element is
  // analyzed for purity exactly like a dynamic singular environment was.
  const environmentFields: {
    environments?: Array<{ value: string | LockInlineValue; dynamic: boolean }>;
  } = {};
  const envRefs =
    job.environments ?? (job.environment !== undefined ? [job.environment] : undefined);
  if (envRefs !== undefined && envRefs.length > 0) {
    environmentFields.environments = envRefs.map((ref) => transformEnvironmentRef(ref, job.name));
  }

  // Resolve env: static object, inline expression (pure function), or dynamic function marker
  const envFields: {
    env?: Record<string, string> | LockInlineValue;
    dynamicEnv?: boolean;
  } = {};
  if (job.env !== undefined) {
    if (typeof job.env === 'function') {
      const fnSource = job.env.toString();
      const purity = analyzePurity(fnSource);
      envFields.dynamicEnv = true;
      if (purity.pure) {
        envFields.env = { _type: 'inline', expression: fnSource };
      } else {
        console.warn(
          `[kici] Job "${job.name}": env function is not pure (${purity.reason}). ` +
            'An init job will be required, adding ~5-10s delay.',
        );
      }
    } else if (typeof job.env === 'object') {
      envFields.env = { ...job.env };
    }
  }

  // Validate per-job resources at compile time so bad memory strings / nonsense
  // request-vs-limit pairs fail fast (before the orchestrator ever sees the lockfile).
  if (job.resources !== undefined) {
    try {
      validateResourceRequest(job.resources);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Job "${job.name}": invalid resources -- ${reason}`);
    }
  }

  // Resolve concurrencyGroup: static string, inline expression (pure function), or dynamic function marker
  const concurrencyFields: {
    concurrencyGroup?: string | LockInlineValue;
    dynamicConcurrencyGroup?: boolean;
  } = {};
  if (job.concurrencyGroup !== undefined) {
    if (typeof job.concurrencyGroup === 'function') {
      const fnSource = job.concurrencyGroup.toString();
      const purity = analyzePurity(fnSource);
      concurrencyFields.dynamicConcurrencyGroup = true;
      if (purity.pure) {
        concurrencyFields.concurrencyGroup = { _type: 'inline', expression: fnSource };
      } else {
        console.warn(
          `[kici] Job "${job.name}": concurrencyGroup function is not pure (${purity.reason}). ` +
            'An init job will be required, adding ~5-10s delay.',
        );
      }
    } else if (typeof job.concurrencyGroup === 'string') {
      concurrencyFields.concurrencyGroup = job.concurrencyGroup;
    }
  }

  return {
    _type: 'static',
    name: job.name,
    ...(job.runsOn !== undefined ? normalizeRunsOnForLock(job.runsOn, job.name) : {}),
    ...(job.runsOnAll !== undefined && {
      runsOnAll: normalizeRunsOnAllToMatchers(
        job.runsOnAll as never,
        `job '${job.name}' runsOnAll`,
      ),
    }),
    ...(job.onUnreachable !== undefined && { onUnreachable: job.onUnreachable }),
    ...(job.includeUninitialized !== undefined && {
      includeUninitialized: job.includeUninitialized,
    }),
    ...(job.maxParallel !== undefined && { maxParallel: job.maxParallel }),
    ...(job.failFast !== undefined && { failFast: job.failFast }),
    ...resolveNeedsForLock(job.needs, uuidToName),
    steps: transformSteps(job.steps, gitRoot),
    matrix: job.matrix ? transformMatrix(job.matrix, job.name, configPath) : undefined,
    include: job.include?.map((inc) => ({ ...inc })),
    exclude: job.exclude?.map((exc) => ({ ...exc })),
    rules: job.rules ? transformRules(job.rules, configPath, index) : undefined,
    description: job.description,
    ...(job.checkout !== undefined && { checkout: job.checkout }),
    ...(job.cache !== undefined && { cache: normalizeCacheSpecs(job.cache) }),
    ...(job.container !== undefined && { container: job.container }),
    ...environmentFields,
    ...envFields,
    ...concurrencyFields,
    ...(job.onCancel !== undefined && { hasOnCancel: true }),
    ...(job.cleanup !== undefined && { hasCleanup: true }),
    ...(job.onSuccess !== undefined && { hasOnSuccess: true }),
    ...(job.onFailure !== undefined && { hasOnFailure: true }),
    ...(job.beforeStep !== undefined && { hasBeforeStep: true }),
    ...(job.afterStep !== undefined && { hasAfterStep: true }),
    ...(job.gracePeriod !== undefined && { gracePeriod: job.gracePeriod }),
    ...(job.timeout !== undefined && { timeout: job.timeout }),
    ...(job.resources !== undefined && { resources: job.resources }),
    ...(job.init !== undefined && { init: job.init }),
    ...(job.approval !== undefined && {
      approval: (assertNonStepApprovalScope(job.approval, 'job'), toLockApproval(job.approval)),
    }),
  };
}

/**
 * Result of resolving needs to lock file format.
 * Contains the serialized needs array and the list of group names for dependsOnGroups.
 */
interface ResolvedNeeds {
  readonly needs: readonly (
    | string
    | import('../types.js').LockNeedsEntry
    | import('../types.js').LockNeedsGroupEntry
  )[];
  readonly dependsOnGroups?: readonly string[];
}

/**
 * Resolve needs to lock file format.
 * Handles strings, Job objects, DynamicGroupRef, and object forms with a `when`
 * run condition (normalized to a `runOn` status-set via the engine helper).
 * Uses the UUID-to-renamed-name mapping so that references to id-less jobs
 * resolve to their lock file names (job-N) instead of the original UUIDs.
 */
function resolveNeedsForLock(
  needs?: Job['needs'],
  uuidToName?: Map<string, string>,
): ResolvedNeeds {
  if (!needs) return { needs: [] };

  const resolvedNeeds: (
    | string
    | import('../types.js').LockNeedsEntry
    | import('../types.js').LockNeedsGroupEntry
  )[] = [];
  const groups: string[] = [];

  for (const need of needs) {
    if (typeof need === 'string') {
      resolvedNeeds.push(uuidToName?.get(need) ?? need);
    } else if (isDynamicGroupRef(need)) {
      // DynamicGroupRef -> NeedsGroupEntry in lock file + dependsOnGroups
      resolvedNeeds.push({ group: need.group, runOn: resolveWhenToRunOn(need.when) });
      groups.push(need.group);
    } else if ('_tag' in need && (need as Job)._tag === 'Job') {
      // Job object -> resolve to name string
      const name = (need as Job).name;
      resolvedNeeds.push(uuidToName?.get(name) ?? name);
    } else if ('group' in need && typeof (need as { group: string }).group === 'string') {
      // Object form { group: string; when } -> NeedsGroupEntry
      const g = need as { group: string; when?: NeedsWhenInput };
      resolvedNeeds.push({ group: g.group, runOn: resolveWhenToRunOn(g.when) });
      groups.push(g.group);
    } else {
      // Object form { name: string; when } -> NeedsEntry
      const n = need as { name: string; when?: NeedsWhenInput };
      const name = uuidToName?.get(n.name) ?? n.name;
      resolvedNeeds.push({ name, runOn: resolveWhenToRunOn(n.when) });
    }
  }

  return {
    needs: resolvedNeeds,
    ...(groups.length > 0 && { dependsOnGroups: groups }),
  };
}

/**
 * Transform steps to lock file format.
 * Assigns counter-based IDs to unnamed steps (bare functions and id-less steps).
 * Counter only increments for unnamed entries; named steps keep their names.
 */
/** Map an SDK `approval` to the normalized lock `approval` block. */
function toLockApproval(c: ApprovalConfig): LockApproval {
  const n = normalizeApproval(c);
  return {
    clauses: n.clauses,
    ...(n.reason !== undefined && { reason: n.reason }),
    ...(n.timeoutSeconds !== undefined && { timeoutSeconds: n.timeoutSeconds }),
    when: n.when,
  };
}

/**
 * Validate an approval config at job/workflow scope: `when: 'drift'` is a
 * step-scope-only gate (it fires between a step's check and run), so it is a
 * compile error anywhere else.
 */
function assertNonStepApprovalScope(c: ApprovalConfig, scope: 'job' | 'workflow'): void {
  if (normalizeApproval(c).when === 'drift') {
    throw new Error(`approval.when "drift" is only valid on steps (found at ${scope} scope)`);
  }
}

/**
 * Validate a step's approval config: `when: 'drift'` fires between the step's
 * check and run, so it requires a `check` facet. A compile error otherwise.
 */
function assertStepApprovalCheckFacet(step: {
  name?: string;
  approval?: ApprovalConfig;
  check?: unknown;
}): void {
  if (
    step.approval !== undefined &&
    normalizeApproval(step.approval).when === 'drift' &&
    step.check === undefined
  ) {
    throw new Error(
      `step '${step.name || '(unnamed)'}': approval.when "drift" requires a check facet`,
    );
  }
}

/** Mutable flat-step counter shared across an entire job's step sequence. */
interface StepCounter {
  n: number;
}

/**
 * Transform a job's `steps` array into lock-file entries. Sequential steps and
 * parallel-group children share one flat `step-N` counter (anonymous steps are
 * numbered across the whole flattened sequence, parallel children inline) so the
 * compiler's naming matches the agent's `extractAndNormalizeSteps` enumeration —
 * the flat-stepIndex invariant.
 */
export function transformSteps(
  steps: readonly StepInput[],
  gitRoot: string,
): readonly LockStepEntry[] {
  const counter: StepCounter = { n: 0 };
  let groupOrdinal = 0;
  return steps.map((entry) => {
    if (isParallelGroup(entry)) {
      return transformParallelGroup(entry, gitRoot, counter, groupOrdinal++);
    }
    return transformSequentialStep(entry, gitRoot, counter);
  });
}

/** Validate and transform a `ParallelGroup` into a `LockParallelStep`. */
function transformParallelGroup(
  group: ParallelGroup,
  gitRoot: string,
  counter: StepCounter,
  groupOrdinal: number,
): LockParallelStep {
  if (group.steps.length === 0) {
    throw new Error('job step: empty parallel group not allowed');
  }
  const seen = new Set<string>();
  const children = group.steps.map((child) => {
    if (isParallelGroup(child)) {
      throw new Error('job step: nested parallel groups are not supported');
    }
    const lockChild = transformSequentialStep(child, gitRoot, counter);
    if (seen.has(lockChild.name)) {
      throw new Error(`job step: duplicate step name '${lockChild.name}' in parallel group`);
    }
    seen.add(lockChild.name);
    return lockChild;
  });
  if (children.length === 1) {
    console.warn(
      `[kici] parallel group with a single step ('${children[0].name}') runs identically to a sequential step`,
    );
  }
  return {
    kind: 'parallel',
    name: group.name ?? `parallel-${groupOrdinal}`,
    failFast: group.failFast,
    ...(group.maxParallel !== undefined && { maxParallel: group.maxParallel }),
    children,
  };
}

/** Transform a single sequential step (or bare function) into a `LockStep`. */
function transformSequentialStep(
  stepOrFn: StepInput,
  gitRoot: string,
  counter: StepCounter,
): LockStep {
  if (typeof stepOrFn === 'function') {
    // Bare function step -- auto-named with counter
    counter.n++;
    return { name: `step-${counter.n}`, hasOutputs: false };
  }
  const step = stepOrFn as Step<any>;
  // Empty name = id-less step -> assign counter
  const name = step.name || `step-${++counter.n}`;
  return {
    name,
    hasOutputs: !!step.outputs && Object.keys(step.outputs).length > 0,
    ...(step.continueOnError !== undefined && { continueOnError: step.continueOnError }),
    ...(step.timeout !== undefined && { timeout: step.timeout }),
    ...(step.retry !== undefined && {
      retry: {
        maxAttempts: step.retry.maxAttempts,
        delayMs: step.retry.delayMs,
        backoff: step.retry.backoff,
        maxDelayMs: step.retry.maxDelayMs,
      },
    }),
    ...(step.cache !== undefined && { cache: normalizeCacheSpecs(step.cache) }),
    ...(step._sourceLocation && {
      sourceLocation: {
        file: makeRelativePath(step._sourceLocation.file, gitRoot),
        line: step._sourceLocation.line,
        column: step._sourceLocation.column,
      },
    }),
    ...(step.rules &&
      step.rules.length > 0 && {
        hasRules: true,
        rules: transformRules(
          step.rules,
          makeRelativePath(step._sourceLocation?.file ?? '', gitRoot),
        ),
      }),
    ...(step.onCancel !== undefined && { hasOnCancel: true }),
    ...(step.cleanup !== undefined && { hasCleanup: true }),
    ...(step.check !== undefined && { hasCheck: true }),
    ...(step.whenInSync !== undefined && { hasWhenInSync: true }),
    ...(step.approval !== undefined && {
      approval: (assertStepApprovalCheckFacet(step), toLockApproval(step.approval)),
    }),
  };
}

/**
 * Strip the `?t=...` query suffix added by cache-busting `import()` calls.
 * The cache-buster is a `Date.now()` query parameter used to defeat Node's
 * module cache. It must not leak into the lock file — it poisons sourceLocation
 * determinism and the top-level contentHash. Handles both `.compiled.mjs?t=...`
 * (rolldown compile path) and `.ts?t=...` (direct TS import path).
 */
function stripCompiledSuffix(filePath: string): string {
  return filePath.replace(/(?:\.compiled\.mjs)?\?t=\d+$/, '');
}

/**
 * Convert an absolute file path to a git-root-relative path.
 * If already relative, returns as-is. Normalizes backslashes to forward slashes.
 * Also strips ephemeral `.compiled.mjs?t=...` suffixes from source locations.
 */
function makeRelativePath(filePath: string, gitRoot: string): string {
  const cleaned = stripCompiledSuffix(filePath);
  if (!path.isAbsolute(cleaned)) {
    return cleaned.replaceAll('\\', '/');
  }
  return path.relative(gitRoot, cleaned).replaceAll('\\', '/');
}

/**
 * Transform matrix configuration to lock file format.
 */
function transformMatrix(matrix: Matrix, jobName: string, configPath: string): LockMatrix {
  // Check if dynamic (function)
  if (isDynamicFunction(matrix)) {
    return {
      _type: 'dynamic',
      source: {
        file: configPath,
        jobName,
      },
    };
  }

  // Static matrix - include values
  if (isStaticArray(matrix)) {
    return {
      _type: 'static',
      values: [...matrix],
    };
  }

  if (isStaticObject(matrix)) {
    // Copy the object structure
    const values: Record<string, readonly string[]> = {};
    for (const [key, arr] of Object.entries(matrix)) {
      values[key] = [...arr];
    }
    return {
      _type: 'static',
      values,
    };
  }

  // Fallback - treat as dynamic if we can't identify it
  return {
    _type: 'dynamic',
    source: {
      file: configPath,
      jobName,
    },
  };
}

/**
 * Transform rules to lock file format.
 * Rules contain functions and can't be serialized - store references.
 */
function transformRules(
  rules: Rule[],
  configPath: string,
  parentIndex?: number,
): readonly LockRule[] {
  return rules.map((rule, index) => ({
    _type: 'dynamic',
    label: rule.label,
    source: {
      file: configPath,
      index: parentIndex !== undefined ? parentIndex * 100 + index : index,
    },
  }));
}

/**
 * Serialize lock file to JSON string.
 *
 * @param lockFile - Lock file object
 * @param pretty - Whether to pretty-print (default: true)
 * @returns JSON string
 */
export function serializeLockFile(lockFile: LockFile, pretty = true): string {
  return JSON.stringify(lockFile, null, pretty ? 2 : undefined);
}
