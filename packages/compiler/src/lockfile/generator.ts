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
  resolveContentFormat,
  stripStatefulRegexFlags,
} from '@kici-dev/engine';
import type {
  LabelMatcher,
  RunsOnPick,
  ContentRequirement,
  LockContentRequirement,
  TextMatch,
  LockTextMatch,
} from '@kici-dev/engine';
import { assertSafeRegex } from '@kici-dev/engine/safe-regex';
import { computeSiblingsDigest } from './workspace-siblings.js';
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
  getDynamicJobGitCredentials,
  isParallelGroup,
} from '@kici-dev/sdk';
import { normalizeCacheSpecs, normalizeApproval } from '@kici-dev/sdk/internal';
import type { ApprovalConfig } from '@kici-dev/sdk';
import {
  SCHEMA_VERSION,
  BREAKING_FLOOR,
  type LockFile,
  type LockSource,
  type LockWorkflow,
  type LockJob,
  type LockDynamicJobFn,
  type LockJobOrFactory,
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
  type LockWorkflowsFailedBatchTrigger,
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
import {
  compilerError,
  locationForJob,
  locationForWorkflow,
  type SourceLocation,
} from '../errors/index.js';
import { computeContentHash, COMPILE_SCHEMA_VERSION } from './hasher.js';
import { resolveHashFiles } from './hash-files.js';

/**
 * Courtesy compatibility warning for `kici compile`, comparing the lock's
 * `minReaderVersion` (`BREAKING_FLOOR`) with the emitted `SCHEMA_VERSION`. Only
 * when `minReader` reaches `version` do orchestrators older than `version` fail
 * to read the lock; below it, null. Informational: the orchestrator is the
 * authoritative reject.
 */
export function schemaWindowWarning(minReader: number, version: number): string | null {
  if (minReader < version) return null;
  return (
    `This lock requires orchestrator schema v${version} or newer — orchestrators ` +
    `older than v${version} cannot read it. Upgrade the orchestrator to schema ` +
    `v${version} or newer before it can dispatch from this lock.`
  );
}

/** Absolute git repository root, or cwd outside a git repo. */
export function detectGitRoot(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return gitRoot;
  } catch {
    return process.cwd();
  }
}

/**
 * Dependency-cache key: hex SHA-256 of the repo's lockfile, or null when none
 * exists.
 *
 * The authoritative lockfile differs by manager: `.kici/package-lock.json` for
 * npm, the repo-root `pnpm-lock.yaml` / `yarn.lock` for a pnpm / yarn workspace
 * (a `.kici/` member resolves against the root lockfile). A standalone `.kici`
 * yarn project is keyed on `.kici/yarn.lock`. The hash input is prefixed with
 * the manager name (plus the yarn flavor, `yarn-classic` / `yarn-berry`), so a
 * restored tarball never has the wrong layout for the agent's install.
 *
 * The detected manager only orders the search; it never restricts it. Detection
 * falls back to the ambient `npm_config_user_agent` when a directory has no
 * signal, so a pnpm-invoked compile of a repo with an npm
 * `.kici/package-lock.json` would otherwise find no lockfile, silently disable
 * the dependency cache, and leave an agent with no registry route unable to run.
 */
export function computeLockfileHash(gitRoot: string): string | null {
  // Root first; `.kici/` covers a standalone project with no root signal.
  const pm =
    detectPackageManagerSync(gitRoot) === PackageManager.Npm
      ? detectPackageManagerSync(path.join(gitRoot, '.kici'))
      : detectPackageManagerSync(gitRoot);

  // Detected manager first, so it wins when more than one lockfile exists.
  const byManager = (m: PackageManager): string[] =>
    m === PackageManager.Pnpm
      ? [path.join(gitRoot, 'pnpm-lock.yaml'), path.join(gitRoot, '.kici', 'pnpm-lock.yaml')]
      : m === PackageManager.Yarn
        ? [path.join(gitRoot, 'yarn.lock'), path.join(gitRoot, '.kici', 'yarn.lock')]
        : [path.join(gitRoot, '.kici', 'package-lock.json')];

  const order: PackageManager[] = [
    pm,
    ...[PackageManager.Npm, PackageManager.Pnpm, PackageManager.Yarn].filter((m) => m !== pm),
  ];

  for (const manager of order) {
    for (const lockfilePath of byManager(manager)) {
      let content: string;
      try {
        content = readFileSync(lockfilePath, 'utf-8');
      } catch {
        continue;
      }
      // Prefix with the matched manager, not the detected one: the tarball's
      // layout is the matched manager's. The yarn flavor is probed in the
      // matched lockfile's directory, the install that lockfile drives.
      const prefix =
        manager === PackageManager.Yarn
          ? `${manager}-${detectYarnFlavorSync(path.dirname(lockfilePath))}`
          : manager;
      return sha256(`${prefix}\n${content}`);
    }
  }
  return null;
}

/** Export reference: `#build`, `#default`, or `#default[0]` for an array item. */
function formatExportRef(source: WorkflowSourceInfo): string {
  if (source.arrayIndex !== undefined) {
    return `#${source.exportName}[${source.arrayIndex}]`;
  }
  return `#${source.exportName}`;
}

/**
 * Generate a lock file from validated workflows with source tracking.
 *
 * @returns Lock file ready for JSON serialization
 */
export function generateLockFile(workflowsWithSource: WorkflowWithSource[]): LockFile {
  const gitRoot = detectGitRoot();
  const lockfileHash = computeLockfileHash(gitRoot);
  // Null unless `.kici` actually depends on an in-repo sibling package, which
  // is the common case — so most locks carry no `siblingsDigest` at all.
  const siblingsDigest = computeSiblingsDigest(gitRoot);

  // Workflows typically share one `.kici/workflows/` directory.
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

  // The content hash covers the whole lock except itself. minReaderVersion
  // makes a reader that predates a breaking change reject the lock instead of
  // mis-parsing it.
  const minReaderVersion = BREAKING_FLOOR;
  const partial = {
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion,
    source: topLevelSource,
    workflows,
  };
  const contentHash = sha256(JSON.stringify(partial));

  return {
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion,
    source: topLevelSource,
    contentHash,
    ...(lockfileHash && { lockfileHash }),
    ...(siblingsDigest && { siblingsDigest }),
    workflows,
  };
}

/** `sourceFile` is git-root-relative; `bundleSource` feeds the content hash. */
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
        (assertNonStepApprovalScope(workflow.approval, 'workflow', locationForWorkflow(sourceFile)),
        toLockApproval(workflow.approval)),
    }),
    // Emitted only when a filter exists: omitting the key keeps the lock for
    // every filter-less workflow byte-identical, so no content hash churns.
    ...(typeof workflow.filter === 'function' && { hasFilter: true }),
  };
}

type TriggerWithRepos = Extract<TriggerConfig, { repos?: readonly unknown[] }>;

/** Adds `repos` only when the trigger carries cross-repo patterns. */
function reposField(
  trigger: Pick<TriggerWithRepos, 'repos'>,
): { repos: readonly LockBranchPattern[] } | Record<string, never> {
  return trigger.repos && trigger.repos.length > 0
    ? { repos: transformBranchPatterns(trigger.repos) }
    : {};
}

type ExtractTrigger<Tag extends TriggerConfig['_tag']> = Extract<TriggerConfig, { _tag: Tag }>;

function toArray<T>(v: T | readonly T[] | undefined): readonly T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v as T];
}

/**
 * The lock's `/pattern/flags` shape. The flag class names every ECMAScript
 * flag: with `[gimsuy]`, a `/release-\d+/v` entry fails to unwrap and is stored
 * as a literal-slash pattern that compiles green and never matches.
 */
const REGEX_ENTRY = /^\/(.+)\/([dgimsuvy]*)$/;

/**
 * Normalize one regex entry to `/pattern/flags`. An invalid or ReDoS-prone
 * pattern fails `kici compile` instead of reaching the orchestrator.
 */
function serializeRegexEntry(entry: string | RegExp, ctx: string): string {
  const source = entry instanceof RegExp ? `/${entry.source}/${entry.flags}` : entry;
  const wrapped = REGEX_ENTRY.exec(source);
  const pattern = wrapped ? wrapped[1] : source;
  // Stateful `g` / `y` are dropped; every other flag round-trips.
  const flags = stripStatefulRegexFlags(wrapped ? wrapped[2] : '');
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw compilerError('E123', `${ctx}: invalid regex — ${reason}`);
  }
  try {
    assertSafeRegex(re.source, re.flags, ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw compilerError('E123', `${ctx}: ${reason}`);
  }
  return `/${re.source}/${re.flags}`;
}

/**
 * Serialize a {@link TextMatch}: every key to a flat array, every regex to
 * `/pattern/flags`, every degenerate shape rejected. `ctx` labels thrown errors
 * (e.g. `requires 'Dockerfile'`).
 */
function serializeTextMatch(m: TextMatch, ctx: string): LockTextMatch {
  const contains = toArray(m.contains);
  const notContains = toArray(m.notContains);
  const matches = toArray(m.matches);
  const notMatches = toArray(m.notMatches);

  if (
    contains.length === 0 &&
    notContains.length === 0 &&
    matches.length === 0 &&
    notMatches.length === 0
  ) {
    throw compilerError(
      'E122',
      `${ctx}: no query key (contains/notContains/matches/notMatches) — nothing to check`,
    );
  }

  for (const needle of [...contains, ...notContains]) {
    if (needle === '') {
      throw compilerError('E122', `${ctx}: an empty needle matches every text — remove it`);
    }
  }

  if (m.ignoreCase !== undefined && contains.length === 0 && notContains.length === 0) {
    throw compilerError(
      'E122',
      `${ctx}: 'ignoreCase' affects only contains/notContains — a regex carries its own flags`,
    );
  }

  return {
    ...(contains.length > 0 && { contains: [...contains] }),
    ...(notContains.length > 0 && { notContains: [...notContains] }),
    ...(matches.length > 0 && { matches: matches.map((e) => serializeRegexEntry(e, ctx)) }),
    ...(notMatches.length > 0 && {
      notMatches: notMatches.map((e) => serializeRegexEntry(e, ctx)),
    }),
    ...(m.ignoreCase !== undefined && { ignoreCase: m.ignoreCase }),
  };
}

function commitMessageField(
  commitMessage: TextMatch | undefined,
  triggerLabel: string,
): { commitMessage?: LockTextMatch } {
  if (commitMessage === undefined) return {};
  return { commitMessage: serializeTextMatch(commitMessage, `${triggerLabel} 'commitMessage'`) };
}

/**
 * Serialize one content requirement, resolving `format: 'auto'` by extension.
 * A malformed filter fails `kici compile` rather than reaching the orchestrator.
 */
function serializeOneRequirement(req: ContentRequirement): LockContentRequirement {
  const hasJsonQuery =
    (req.exists !== undefined && req.exists.length > 0) ||
    (req.match !== undefined && Object.keys(req.match).length > 0) ||
    (req.not !== undefined && Object.keys(req.not).length > 0);
  const textKeys = {
    ...(req.contains !== undefined && { contains: req.contains }),
    ...(req.notContains !== undefined && { notContains: req.notContains }),
    ...(req.matches !== undefined && { matches: req.matches }),
    ...(req.notMatches !== undefined && { notMatches: req.notMatches }),
    ...(req.ignoreCase !== undefined && { ignoreCase: req.ignoreCase }),
  } satisfies TextMatch;
  const hasTextQuery =
    req.contains !== undefined ||
    req.notContains !== undefined ||
    req.matches !== undefined ||
    req.notMatches !== undefined;
  const hasAnyQuery = hasJsonQuery || hasTextQuery || req.ignoreCase !== undefined;

  if (req.absent) {
    if (hasAnyQuery) {
      throw compilerError(
        'E118',
        `requires '${req.file}': 'absent' is mutually exclusive with query keys (exists/match/not/contains/notContains/matches/notMatches)`,
      );
    }
    return { file: req.file, absent: true };
  }

  const format = resolveContentFormat(req.file, req.format);

  if (format === 'text' && hasJsonQuery) {
    throw compilerError(
      'E119',
      `requires '${req.file}': text format cannot carry a json/yaml query key (exists/match/not) — name a .json/.yaml file or set format: 'json' | 'yaml'`,
    );
  }
  if (format !== 'text' && (hasTextQuery || req.ignoreCase !== undefined)) {
    throw compilerError(
      'E119',
      `requires '${req.file}': '${format}' format cannot carry a raw-text key (contains/notContains/matches/notMatches/ignoreCase) — use format: 'text'`,
    );
  }

  // A bare `{ file }` is a valid existence check; an explicit format with no query is degenerate.
  if (!hasAnyQuery) {
    if (req.format !== undefined) {
      throw compilerError(
        'E122',
        `requires '${req.file}': format '${req.format}' declared with no query key — nothing to check`,
      );
    }
    return { file: req.file };
  }

  const text = hasTextQuery ? serializeTextMatch(textKeys, `requires '${req.file}'`) : {};

  return {
    file: req.file,
    format,
    ...(req.exists !== undefined && { exists: req.exists }),
    ...(req.match !== undefined && { match: req.match }),
    ...(req.not !== undefined && { not: req.not }),
    ...text,
  };
}

/** `undefined` for an empty list, so the lock field stays absent. */
function serializeRequires(
  requires: readonly ContentRequirement[] | undefined,
): readonly LockContentRequirement[] | undefined {
  if (!requires || requires.length === 0) return undefined;
  return requires.map(serializeOneRequirement);
}

function requiresField(requires: readonly ContentRequirement[] | undefined): {
  requires?: readonly LockContentRequirement[];
} {
  const serialized = serializeRequires(requires);
  return serialized ? { requires: serialized } : {};
}

function toLockPr(t: ExtractTrigger<'PrTrigger'>): LockPrTrigger {
  return {
    _type: 'pr',
    events: t.events,
    targetBranches: transformBranchPatterns(t.targetBranches),
    sourceBranches: transformBranchPatterns(t.sourceBranches),
    paths: t.paths,
    ...reposField(t),
    ...requiresField(t.requires),
    ...commitMessageField(t.commitMessage, 'pr trigger'),
  };
}

function toLockPushAndTag(t: ExtractTrigger<'PushTrigger'>): LockTrigger[] {
  // Resolved once: the push and its derived tag trigger share both filters.
  const requires = requiresField(t.requires);
  const commitMessage = commitMessageField(t.commitMessage, 'push trigger');
  const results: LockTrigger[] = [
    {
      _type: 'push',
      branches: transformBranchPatterns(t.branches),
      paths: t.paths,
      ...reposField(t),
      ...requires,
      ...commitMessage,
    } satisfies LockPushTrigger,
  ];
  if (t.tags.length > 0) {
    results.push({
      _type: 'tag',
      patterns: transformBranchPatterns(t.tags),
      ...requires,
      ...commitMessage,
    } satisfies LockTagTrigger);
  }
  return results;
}

function toLockTag(t: ExtractTrigger<'TagTrigger'>): LockTagTrigger {
  return {
    _type: 'tag',
    patterns: transformBranchPatterns(t.patterns),
    ...reposField(t),
    ...requiresField(t.requires),
    ...commitMessageField(t.commitMessage, 'tag trigger'),
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

function toLockWorkflowsFailedBatch(
  t: ExtractTrigger<'WorkflowsFailedBatchTrigger'>,
): LockWorkflowsFailedBatchTrigger {
  return {
    _type: 'workflows_failed_batch',
    accumulateFor: t.accumulateFor,
    ...(t.name !== undefined && { name: t.name }),
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
    case 'WorkflowsFailedBatchTrigger':
      return [toLockWorkflowsFailedBatch(trigger)];
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
 * flatMap: a push trigger with tags emits two lock triggers. Exported for the
 * test runner's in-memory lock conversion.
 */
export function transformTriggers(triggers?: TriggerConfig[]): readonly LockTrigger[] {
  if (!triggers) return [];
  return triggers.flatMap(transformOneTrigger);
}

function transformBranchPatterns(
  patterns: readonly { type: 'glob' | 'regex'; pattern: string; flags?: string }[],
): readonly LockBranchPattern[] {
  return patterns.map((p) => ({
    type: p.type,
    pattern: p.pattern,
    flags: p.flags,
  }));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID-named jobs (from the id-less `job()` factory) become `job-N`, counting
 * only those; named jobs keep their names. A pre-pass maps UUIDs to `job-N` so
 * `needs` references resolve to lock names, not UUIDs.
 */
function transformJobs(
  jobs: JobOrFactory[],
  configPath: string,
  gitRoot: string,
): readonly LockJobOrFactory[] {
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
      // A generator cannot be serialized; store a reference.
      const groupName = getDynamicJobGroup(jobOrFactory);
      const declaredNeeds = getDynamicJobNeeds(jobOrFactory);
      // The credential ceiling for every generated job: the orchestrator reads
      // it from this lock entry, never from the agent's eval result.
      const declaredGitCredentials = getDynamicJobGitCredentials(jobOrFactory);
      // Same normalization as static `needs`, so the deferred eval job is
      // gated identically.
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
        ...(declaredGitCredentials && { gitCredentials: declaredGitCredentials }),
      } satisfies LockDynamicJobFn;
    }

    const j = jobOrFactory as Job;
    const isUuid = UUID_PATTERN.test(j.name);
    const name = isUuid ? `job-${++jobCounter}` : j.name;
    return transformJob({ ...j, name } as Job, configPath, index, gitRoot, uuidToName);
  });
}

/**
 * Plain strings stay exact; globs and RegExp literals become regex. Throws on a
 * ReDoS-prone author regex (engine gate).
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
 * Reject overlap between required and excluded labels (exact matchers only: a
 * glob/regex cannot be statically known to overlap).
 *
 * `kici:` labels are valid selectors: runsOn only narrows the candidate set and
 * never grants authority. The forgery boundary is label *setting* (scaler
 * labelSet validation and the agent register-time scope gate), enforced elsewhere.
 */
function validateRunsOn(runsOn: RunsOn, jobName: string, location: SourceLocation): void {
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
    throw compilerError(
      'E112',
      `Job "${jobName}": labels and exclude overlap on [${overlap.join(', ')}]. A label cannot be both required and excluded.`,
      {
        location,
        suggestion: 'Remove the overlapping label(s) from either runsOn or the exclude set.',
      },
    );
  }
}

/** A function ref carries only the `dynamic` flag; the agent init round resolves it. */
function transformContextRef(ref: NonNullable<Job['contexts']>[number]): {
  value: string;
  dynamic: boolean;
} {
  if (typeof ref === 'function') {
    return { value: '', dynamic: true };
  }
  return { value: ref, dynamic: false };
}

function transformJob(
  job: Job,
  configPath: string,
  index: number,
  gitRoot: string,
  uuidToName?: Map<string, string>,
): LockJob {
  // The job's first step location, else the workflow file at line 1.
  const jobLocation = locationForJob(job, configPath);

  if (job.runsOn !== undefined && job.runsOnAll !== undefined) {
    throw compilerError('E108', `job '${job.name}': runsOn and runsOnAll are mutually exclusive`, {
      location: jobLocation,
      suggestion:
        'Set exactly one of runsOn (single agent) or runsOnAll (fan-out to every matching agent).',
    });
  }
  // An invoke gate never dispatches to an agent, so it names no target.
  if (job.invoke === undefined && job.runsOn === undefined && job.runsOnAll === undefined) {
    throw compilerError('E109', `job '${job.name}': one of runsOn or runsOnAll is required`, {
      location: jobLocation,
      suggestion: 'Add runsOn: "kici:os:linux" (or another agent label) to the job.',
    });
  }
  if (job.onUnreachable !== undefined && job.runsOnAll === undefined) {
    console.warn(`[kici] job '${job.name}': onUnreachable is ignored without runsOnAll`);
  }
  if (job.maxParallel !== undefined && job.maxParallel < 1) {
    throw compilerError('E110', `job '${job.name}': maxParallel must be >= 1`, {
      location: jobLocation,
      suggestion: 'Set maxParallel to a positive integer, or remove it to run unbounded.',
    });
  }
  const hasFanout = job.matrix !== undefined || job.runsOnAll !== undefined;
  if (!hasFanout && (job.maxParallel !== undefined || job.failFast !== undefined)) {
    console.warn(
      `[kici] job '${job.name}': maxParallel/failFast are ignored without matrix or runsOnAll (no fan-out to bound)`,
    );
  }
  if (job.runsOn !== undefined) validateRunsOn(job.runsOn, job.name, jobLocation);

  // `context: 'x'` normalizes to a one-element `contexts` array, kept in order.
  const contextFields: {
    contexts?: Array<{ value: string; dynamic: boolean }>;
  } = {};
  const contextRefs = job.contexts ?? (job.context !== undefined ? [job.context] : undefined);
  if (contextRefs !== undefined && contextRefs.length > 0) {
    contextFields.contexts = contextRefs.map((ref) => transformContextRef(ref));
  }

  // A function env becomes a marker the agent init round resolves.
  const envFields: {
    env?: Record<string, string>;
    dynamicEnv?: boolean;
  } = {};
  if (job.env !== undefined) {
    if (typeof job.env === 'function') {
      envFields.dynamicEnv = true;
    } else if (typeof job.env === 'object') {
      envFields.env = { ...job.env };
    }
  }

  // Fail at compile time, before the orchestrator sees the lock.
  if (job.resources !== undefined) {
    try {
      validateResourceRequest(job.resources);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw compilerError('E111', `Job "${job.name}": invalid resources -- ${reason}`, {
        location: jobLocation,
        suggestion: 'Fix the resources request (valid CPU/memory strings, request <= limit).',
      });
    }
  }

  // A function concurrencyGroup becomes a marker the agent init round resolves.
  const concurrencyFields: {
    concurrencyGroup?: string;
    dynamicConcurrencyGroup?: boolean;
  } = {};
  if (job.concurrencyGroup !== undefined) {
    if (typeof job.concurrencyGroup === 'function') {
      concurrencyFields.dynamicConcurrencyGroup = true;
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
    ...(job.gitCredentials !== undefined && { gitCredentials: job.gitCredentials }),
    ...(job.maxParallel !== undefined && { maxParallel: job.maxParallel }),
    ...(job.failFast !== undefined && { failFast: job.failFast }),
    ...(job.invoke !== undefined && {
      invoke: {
        event: job.invoke.event,
        scope: job.invoke.scope,
        ...(job.invoke.payload !== undefined && { payload: job.invoke.payload }),
        ...(job.invoke.optional === true && { optional: true }),
      },
    }),
    ...resolveNeedsForLock(job.needs, uuidToName),
    steps: transformSteps(job.steps, gitRoot, jobLocation),
    matrix: job.matrix ? transformMatrix(job.matrix, job.name, configPath) : undefined,
    include: job.include?.map((inc) => ({ ...inc })),
    exclude: job.exclude?.map((exc) => ({ ...exc })),
    rules: job.rules ? transformRules(job.rules, configPath, index) : undefined,
    description: job.description,
    ...(job.checkout !== undefined && { checkout: job.checkout }),
    ...(job.cache !== undefined && { cache: normalizeCacheSpecs(job.cache) }),
    ...(job.container !== undefined && { container: job.container }),
    ...(job.sandbox !== undefined && { sandbox: job.sandbox }),
    ...contextFields,
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
      approval:
        (assertNonStepApprovalScope(job.approval, 'job', jobLocation),
        toLockApproval(job.approval)),
    }),
  };
}

interface ResolvedNeeds {
  readonly needs: readonly (
    string | import('../types.js').LockNeedsEntry | import('../types.js').LockNeedsGroupEntry
  )[];
  readonly dependsOnGroups?: readonly string[];
}

/**
 * A `when` condition normalizes to a `runOn` status set; references to id-less
 * jobs resolve to their `job-N` lock names through `uuidToName`.
 */
function resolveNeedsForLock(
  needs?: Job['needs'],
  uuidToName?: Map<string, string>,
): ResolvedNeeds {
  if (!needs) return { needs: [] };

  const resolvedNeeds: (
    string | import('../types.js').LockNeedsEntry | import('../types.js').LockNeedsGroupEntry
  )[] = [];
  const groups: string[] = [];

  for (const need of needs) {
    if (typeof need === 'string') {
      resolvedNeeds.push(uuidToName?.get(need) ?? need);
    } else if (isDynamicGroupRef(need)) {
      resolvedNeeds.push({ group: need.group, runOn: resolveWhenToRunOn(need.when) });
      groups.push(need.group);
    } else if ('_tag' in need && (need as Job)._tag === 'Job') {
      const name = (need as Job).name;
      resolvedNeeds.push(uuidToName?.get(name) ?? name);
    } else if ('group' in need && typeof (need as { group: string }).group === 'string') {
      const g = need as { group: string; when?: NeedsWhenInput };
      resolvedNeeds.push({ group: g.group, runOn: resolveWhenToRunOn(g.when) });
      groups.push(g.group);
    } else {
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

function toLockApproval(c: ApprovalConfig): LockApproval {
  const n = normalizeApproval(c);
  return {
    clauses: n.clauses,
    ...(n.reason !== undefined && { reason: n.reason }),
    ...(n.timeoutSeconds !== undefined && { timeoutSeconds: n.timeoutSeconds }),
    when: n.when,
  };
}

/** `when: 'drift'` fires between a step's check and run, so it is step-scope only. */
function assertNonStepApprovalScope(
  c: ApprovalConfig,
  scope: 'job' | 'workflow',
  location: SourceLocation,
): void {
  if (normalizeApproval(c).when === 'drift') {
    throw compilerError(
      'E113',
      `approval.when "drift" is only valid on steps (found at ${scope} scope)`,
      {
        location,
        suggestion:
          'Move the drift-gated approval onto a step, or use when: "always" at job/workflow scope.',
      },
    );
  }
}

/** `when: 'drift'` fires between check and run, so it requires a `check` facet. */
function assertStepApprovalCheckFacet(
  step: {
    name?: string;
    approval?: ApprovalConfig;
    check?: unknown;
    _sourceLocation?: SourceLocation;
  },
  jobLocation: SourceLocation,
): void {
  if (
    step.approval !== undefined &&
    normalizeApproval(step.approval).when === 'drift' &&
    step.check === undefined
  ) {
    throw compilerError(
      'E114',
      `step '${step.name || '(unnamed)'}': approval.when "drift" requires a check facet`,
      {
        location: step._sourceLocation ?? jobLocation,
        suggestion: 'Add a check facet to the step, or use approval when: "always".',
      },
    );
  }
}

/** Shared across a job's whole step sequence. */
interface StepCounter {
  n: number;
}

/**
 * Sequential steps and parallel-group children share one flat `step-N` counter
 * for anonymous steps, so naming matches the agent's `extractAndNormalizeSteps`
 * enumeration (the flat-stepIndex invariant). Named steps keep their names.
 */
export function transformSteps(
  steps: readonly StepInput[],
  gitRoot: string,
  jobLocation?: SourceLocation,
): readonly LockStepEntry[] {
  const anchor = jobLocation ?? { file: '', line: 1, column: 1 };
  const counter: StepCounter = { n: 0 };
  let groupOrdinal = 0;
  return steps.map((entry) => {
    if (isParallelGroup(entry)) {
      return transformParallelGroup(entry, gitRoot, counter, groupOrdinal++, anchor);
    }
    return transformSequentialStep(entry, gitRoot, counter, anchor);
  });
}

function stepEntryLocation(entry: unknown, jobLocation: SourceLocation): SourceLocation {
  return (entry as { _sourceLocation?: SourceLocation })._sourceLocation ?? jobLocation;
}

function transformParallelGroup(
  group: ParallelGroup,
  gitRoot: string,
  counter: StepCounter,
  groupOrdinal: number,
  jobLocation: SourceLocation,
): LockParallelStep {
  if (group.steps.length === 0) {
    throw compilerError('E115', 'job step: empty parallel group not allowed', {
      location: jobLocation,
      suggestion: 'Add at least one step to the parallel group, or remove the group.',
    });
  }
  const seen = new Set<string>();
  const children = group.steps.map((child) => {
    if (isParallelGroup(child)) {
      throw compilerError('E116', 'job step: nested parallel groups are not supported', {
        location: stepEntryLocation(child, jobLocation),
        suggestion: 'Flatten the nested group — a parallel group may only contain steps.',
      });
    }
    const lockChild = transformSequentialStep(child, gitRoot, counter, jobLocation);
    if (seen.has(lockChild.name)) {
      throw compilerError(
        'E117',
        `job step: duplicate step name '${lockChild.name}' in parallel group`,
        {
          location: stepEntryLocation(child, jobLocation),
          suggestion: 'Give each step in a parallel group a unique name.',
        },
      );
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

function transformSequentialStep(
  stepOrFn: StepInput,
  gitRoot: string,
  counter: StepCounter,
  jobLocation: SourceLocation,
): LockStep {
  if (typeof stepOrFn === 'function') {
    counter.n++;
    return { name: `step-${counter.n}`, hasOutputs: false };
  }
  const step = stepOrFn as Step<any>;
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
      approval: (assertStepApprovalCheckFacet(step, jobLocation), toLockApproval(step.approval)),
    }),
  };
}

/**
 * Strip the `Date.now()` `?t=...` cache-buster from `.compiled.mjs?t=...`
 * (rolldown path) and `.ts?t=...` (direct import). Leaked into the lock, it
 * breaks sourceLocation determinism and the top-level contentHash.
 */
function stripCompiledSuffix(filePath: string): string {
  return filePath.replace(/(?:\.compiled\.mjs)?\?t=\d+$/, '');
}

/** Git-root-relative, forward-slashed, cache-buster stripped; a relative path stays put. */
function makeRelativePath(filePath: string, gitRoot: string): string {
  const cleaned = stripCompiledSuffix(filePath);
  if (!path.isAbsolute(cleaned)) {
    return cleaned.replaceAll('\\', '/');
  }
  return path.relative(gitRoot, cleaned).replaceAll('\\', '/');
}

function transformMatrix(matrix: Matrix, jobName: string, configPath: string): LockMatrix {
  if (isDynamicFunction(matrix)) {
    return {
      _type: 'dynamic',
      source: {
        file: configPath,
        jobName,
      },
    };
  }

  if (isStaticArray(matrix)) {
    return {
      _type: 'static',
      values: [...matrix],
    };
  }

  if (isStaticObject(matrix)) {
    const values: Record<string, readonly string[]> = {};
    for (const [key, arr] of Object.entries(matrix)) {
      values[key] = [...arr];
    }
    return {
      _type: 'static',
      values,
    };
  }

  // Unrecognized shapes are treated as dynamic.
  return {
    _type: 'dynamic',
    source: {
      file: configPath,
      jobName,
    },
  };
}

/** Rules hold functions, so the lock stores references. */
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
 * @param pretty - Whether to pretty-print (default: true)
 */
export function serializeLockFile(lockFile: LockFile, pretty = true): string {
  return JSON.stringify(lockFile, null, pretty ? 2 : undefined);
}
