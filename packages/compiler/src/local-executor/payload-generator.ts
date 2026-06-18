import { execSync } from 'node:child_process';
import { parseEventArg } from '../test-runner/event-types.js';
import { buildEventPayload } from '../test-runner/payload-builder.js';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { RunLocalOptions } from './types.js';

const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Run a git command and return trimmed output, or null on failure.
 */
function git(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Detect current git branch name.
 */
function detectBranch(): string | null {
  return git('git rev-parse --abbrev-ref HEAD');
}

/**
 * Detect current git HEAD SHA.
 */
function detectSha(): string | null {
  return git('git rev-parse HEAD');
}

/**
 * Detect changed files from git diff (unstaged + staged, deduplicated).
 */
function detectChangedFiles(): string[] {
  const unstaged = git('git diff --name-only HEAD');
  const staged = git('git diff --name-only --cached');

  const files = new Set<string>();

  if (unstaged) {
    for (const f of unstaged.split('\n').filter(Boolean)) {
      files.add(f);
    }
  }

  if (staged) {
    for (const f of staged.split('\n').filter(Boolean)) {
      files.add(f);
    }
  }

  return [...files];
}

/**
 * Generate a SimulatedEvent from git state and CLI overrides.
 *
 * For push events: detects branch, SHA, and changed files from git.
 * For PR events: uses current branch as source, 'main' (or --branch) as target.
 * If --payload flag is provided, delegates to existing buildEventPayload.
 * Falls back gracefully when not in a git repository.
 *
 * @param event - Event argument string (e.g. 'push', 'pr:open')
 * @param options - CLI options with override fields
 * @returns Generated SimulatedEvent
 */
export async function generateEventPayload(
  event: string,
  options: RunLocalOptions,
): Promise<SimulatedEvent> {
  // If --payload flag is provided, delegate to existing payload builder
  if (options.payload) {
    return buildEventPayload(event, {
      payload: options.payload,
      branch: options.branch,
      sha: options.sha,
      files: options.files,
    });
  }

  const eventType = parseEventArg(event);

  // Auto-detect git state with graceful fallback
  const detectedBranch = detectBranch() ?? 'main';
  const detectedSha = detectSha() ?? ZERO_SHA;
  const changedFiles =
    options.files && options.files.length > 0 ? options.files : detectChangedFiles();

  // Apply overrides
  const branch = options.branch ?? detectedBranch;
  const sha = options.sha ?? detectedSha;

  // Build event based on type
  switch (eventType.type) {
    case 'push':
      return {
        type: 'push',
        payload: {
          ref: `refs/heads/${branch}`,
          after: sha,
          before: ZERO_SHA,
          head_commit: { id: sha, message: 'local execution' },
          repository: { default_branch: 'main' },
        },
        targetBranch: branch,
        changedFiles,
      };

    case 'pull_request': {
      const action = 'action' in eventType ? eventType.action : 'opened';
      // For PRs: current branch is source, --branch (or 'main') is target
      const targetBranch = options.branch ?? 'main';
      const sourceBranch = detectedBranch;
      return {
        type: 'pull_request',
        action,
        payload: {
          action,
          number: 1,
          pull_request: {
            number: 1,
            head: { ref: sourceBranch, sha },
            base: { ref: targetBranch },
          },
          repository: { default_branch: 'main' },
        },
        targetBranch,
        sourceBranch,
        changedFiles,
      };
    }

    case 'tag':
      return {
        type: 'tag',
        payload: {
          ref: `refs/tags/${branch}`,
          after: sha,
          repository: { default_branch: 'main' },
        },
        targetBranch: branch,
        changedFiles,
      };

    default: {
      // For other event types, build a generic payload
      const action = 'action' in eventType ? eventType.action : undefined;
      return {
        type: eventType.type,
        action,
        payload: {
          repository: { default_branch: 'main' },
        },
        targetBranch: branch,
        changedFiles,
      };
    }
  }
}
