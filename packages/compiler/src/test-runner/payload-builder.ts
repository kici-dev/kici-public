import { readFile } from 'node:fs/promises';
import { getDefaultFixture } from '../fixtures/defaults/index.js';
import { detectRepoFromGit } from './git-detector.js';
import { parseEventArg } from './event-types.js';
import type { SimulatedEvent, ChangedFilesStatus } from '@kici-dev/engine';

export interface PayloadOptions {
  /** Path to a custom fixture file. */
  payload?: string;
  branch?: string;
  pr?: number;
  /** `owner/name`. */
  repo?: string;
  sha?: string;
  /** Changed paths for onChangedFiles trigger matching. */
  files?: string[];
  /**
   * Defaults to `'fetched'` (the file list is a genuine diff); `'unavailable'`
   * tests a rule's `ctx.changedFilesStatus` guard on a diff-less event.
   */
  changedFilesStatus?: ChangedFilesStatus;
}

/** Arrays replace; null and undefined overrides are ignored. */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === 'object'
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/** Default fixture or custom file, then the CLI overrides. */
export async function buildEventPayload(
  eventArg: string,
  options: PayloadOptions,
): Promise<SimulatedEvent> {
  const eventType = parseEventArg(eventArg);

  if (isInternalEventType(eventType)) {
    return buildInternalEventPayload(eventType, options);
  }

  let payload: Record<string, unknown>;
  if (options.payload) {
    const content = await readFile(options.payload, 'utf-8');
    payload = JSON.parse(content);
  } else {
    payload = getDefaultFixture(eventArg) as Record<string, unknown>;
  }

  const repoInfo = options.repo ? null : await detectRepoFromGit();

  const overrides: Record<string, unknown> = {};

  if (options.repo) {
    const [owner, name] = options.repo.split('/');
    overrides.repository = {
      owner: { login: owner },
      name,
      full_name: options.repo,
    };
  } else if (repoInfo) {
    overrides.repository = {
      owner: { login: repoInfo.owner },
      name: repoInfo.name,
      full_name: `${repoInfo.owner}/${repoInfo.name}`,
    };
  }

  if (options.sha) {
    switch (eventType.type) {
      case 'push':
      case 'tag':
        overrides.after = options.sha;
        break;
      case 'status':
        overrides.sha = options.sha;
        break;
      case 'pull_request':
      case 'review':
      case 'review_comment':
        overrides.pull_request = { head: { sha: options.sha } };
        break;
      case 'workflow_run':
        overrides.workflow_run = { head_sha: options.sha };
        break;
      // Other events carry no SHA field.
    }
  }

  if (options.branch) {
    switch (eventType.type) {
      case 'push':
        overrides.ref = `refs/heads/${options.branch}`;
        break;
      case 'tag':
        overrides.ref = `refs/tags/${options.branch}`;
        break;
      case 'pull_request':
      case 'review':
      case 'review_comment':
        overrides.pull_request = {
          ...((overrides.pull_request as Record<string, unknown>) ?? {}),
          base: { ref: options.branch },
        };
        break;
      case 'release':
        overrides.release = { target_commitish: options.branch };
        break;
      case 'create':
      case 'delete':
        overrides.ref = options.branch;
        break;
      case 'workflow_run':
        overrides.workflow_run = {
          ...((overrides.workflow_run as Record<string, unknown>) ?? {}),
          head_branch: options.branch,
        };
        break;
      // Other events use the repository's default branch.
    }
  }

  if (
    options.pr &&
    (eventType.type === 'pull_request' ||
      eventType.type === 'review' ||
      eventType.type === 'review_comment')
  ) {
    overrides.number = options.pr;
    overrides.pull_request = {
      ...((overrides.pull_request as Record<string, unknown>) ?? {}),
      number: options.pr,
    };
  }

  const mergedPayload = deepMerge(payload, overrides);

  let targetBranch = 'main';
  let sourceBranch: string | undefined;

  const repo = mergedPayload.repository as Record<string, unknown> | undefined;
  const defaultBranch = (repo?.default_branch as string) ?? 'main';

  switch (eventType.type) {
    case 'push': {
      const ref = (mergedPayload.ref as string) ?? 'refs/heads/main';
      targetBranch = ref.replace('refs/heads/', '');
      break;
    }

    case 'tag': {
      const ref = (mergedPayload.ref as string) ?? 'refs/tags/v0.0.0';
      targetBranch = ref.replace('refs/tags/', '');
      break;
    }

    case 'pull_request': {
      const pr = mergedPayload.pull_request as Record<string, unknown> | undefined;
      targetBranch = ((pr?.base as Record<string, unknown>)?.ref as string) ?? defaultBranch;
      sourceBranch = (pr?.head as Record<string, unknown>)?.ref as string;
      break;
    }

    case 'comment': {
      // A PR comment carries its pull_request data in the issue.
      const issue = mergedPayload.issue as Record<string, unknown> | undefined;
      const pr = issue?.pull_request as Record<string, unknown> | undefined;
      targetBranch = (pr?.base_ref as string) ?? defaultBranch;
      break;
    }

    case 'review':
    case 'review_comment': {
      const pr = mergedPayload.pull_request as Record<string, unknown> | undefined;
      targetBranch = ((pr?.base as Record<string, unknown>)?.ref as string) ?? defaultBranch;
      sourceBranch = (pr?.head as Record<string, unknown>)?.ref as string;
      break;
    }

    case 'release': {
      const release = mergedPayload.release as Record<string, unknown> | undefined;
      targetBranch = (release?.target_commitish as string) ?? defaultBranch;
      break;
    }

    case 'dispatch':
      targetBranch = defaultBranch;
      break;

    case 'create':
    case 'delete':
      targetBranch = (mergedPayload.ref as string) ?? defaultBranch;
      // e.g. create:tag, delete:tag
      if ('refType' in eventType && eventType.refType) {
        mergedPayload.ref_type = eventType.refType;
      }
      break;

    case 'status': {
      const branches = mergedPayload.branches as Array<Record<string, unknown>> | undefined;
      targetBranch = (branches?.[0]?.name as string) ?? defaultBranch;
      break;
    }

    case 'workflow_run': {
      const wr = mergedPayload.workflow_run as Record<string, unknown> | undefined;
      targetBranch = (wr?.head_branch as string) ?? defaultBranch;
      break;
    }

    case 'fork':
    case 'star':
    case 'watch':
      targetBranch = defaultBranch;
      break;
  }

  return {
    type: eventType.type,
    action: 'action' in eventType ? eventType.action : undefined,
    payload: mergedPayload,
    targetBranch,
    sourceBranch,
    changedFiles: options.files ?? [],
    changedFilesStatus: options.changedFilesStatus ?? 'fetched',
  };
}

type InternalEventType =
  | { type: 'kici_event'; eventName: string }
  | { type: 'workflow_complete'; workflowName: string; status: string }
  | { type: 'workflows_failed_batch' }
  | { type: 'job_complete'; workflowName: string; jobName: string; status: string }
  | { type: 'generic_webhook'; source?: string }
  | { type: 'schedule'; cronExpression?: string; timezone?: string }
  | { type: 'lifecycle'; lifecycleEvent: string };

/** Internal means non-GitHub. */
function isInternalEventType(
  eventType: import('./event-types.js').EventType,
): eventType is InternalEventType {
  return [
    'kici_event',
    'workflow_complete',
    'workflows_failed_batch',
    'job_complete',
    'generic_webhook',
    'schedule',
    'lifecycle',
  ].includes(eventType.type);
}

/** Internal events have no GitHub fixture, so the payload is built here unless a file is given. */
async function buildInternalEventPayload(
  eventType: InternalEventType,
  options: PayloadOptions,
): Promise<SimulatedEvent> {
  let payload: Record<string, unknown>;

  if (options.payload) {
    const content = await readFile(options.payload, 'utf-8');
    payload = JSON.parse(content);
  } else {
    switch (eventType.type) {
      case 'kici_event':
        payload = { eventName: eventType.eventName };
        break;
      case 'workflow_complete':
        payload = { workflowName: eventType.workflowName, status: eventType.status };
        break;
      case 'workflows_failed_batch':
        payload = { total: 0, runs: [] };
        break;
      case 'job_complete':
        payload = {
          workflowName: eventType.workflowName,
          jobName: eventType.jobName,
          status: eventType.status,
        };
        break;
      case 'generic_webhook':
        payload = eventType.source ? { source: eventType.source } : {};
        break;
      case 'schedule':
        payload = {
          cronExpression: eventType.cronExpression ?? '*',
          timezone: eventType.timezone ?? 'UTC',
        };
        break;
      case 'lifecycle':
        payload = {
          lifecycleEvent: eventType.lifecycleEvent,
        };
        break;
    }
  }

  return {
    type: eventType.type,
    action: undefined,
    payload,
    targetBranch: 'main', // Internal events are not branch-related
    changedFiles: options.files ?? [],
    changedFilesStatus: options.changedFilesStatus ?? 'fetched',
  };
}
