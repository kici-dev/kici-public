/**
 * Built-in fixture registry for common GitHub webhook events.
 * Supports all 15 trigger types defined in the SDK.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function load(filename: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, filename), 'utf-8'));
}

// --- PR fixtures ---
const prOpened = load('pr-opened.json');
const prSynchronize = load('pr-synchronize.json');
const prClosed = load('pr-closed.json');
const prReopened = load('pr-reopened.json');

// --- Push / tag ---
const pushFixture = load('push.json');
const tagPush = load('tag-push.json');

// --- New event fixtures ---
const commentCreated = load('comment-created.json');
const releasePublished = load('release-published.json');
const dispatchFixture = load('dispatch.json');
const createBranch = load('create-branch.json');
const deleteBranch = load('delete-branch.json');
const statusFixture = load('status.json');
const forkFixture = load('fork.json');
const starCreated = load('star-created.json');
const watchStarted = load('watch-started.json');
const reviewSubmitted = load('review-submitted.json');
const reviewCommentCreated = load('review-comment-created.json');
const workflowRunCompleted = load('workflow-run-completed.json');

const FIXTURES: Record<string, unknown> = {
  // PR events
  'pr:open': prOpened,
  'pr:opened': prOpened,
  'pr:sync': prSynchronize,
  'pr:synchronize': prSynchronize,
  'pr:close': prClosed,
  'pr:closed': prClosed,
  'pr:reopen': prReopened,
  'pr:reopened': prReopened,

  // Push
  push: pushFixture,

  // Tag
  tag: tagPush,

  // Comment (issue_comment)
  comment: commentCreated,
  'comment:created': commentCreated,
  'comment:edited': commentCreated, // Reuse created fixture (action overridden in payload builder)
  'comment:deleted': commentCreated,

  // Review (pull_request_review)
  review: reviewSubmitted,
  'review:submitted': reviewSubmitted,
  'review:edited': reviewSubmitted,
  'review:dismissed': reviewSubmitted,

  // Review comment (pull_request_review_comment)
  review_comment: reviewCommentCreated,
  'review_comment:created': reviewCommentCreated,
  'review_comment:edited': reviewCommentCreated,
  'review_comment:deleted': reviewCommentCreated,

  // Release
  release: releasePublished,
  'release:published': releasePublished,
  'release:unpublished': releasePublished,
  'release:created': releasePublished,
  'release:edited': releasePublished,
  'release:deleted': releasePublished,
  'release:prereleased': releasePublished,
  'release:released': releasePublished,

  // Dispatch (repository_dispatch)
  dispatch: dispatchFixture,

  // Create
  create: createBranch,
  'create:branch': createBranch,
  'create:tag': createBranch,

  // Delete
  delete: deleteBranch,
  'delete:branch': deleteBranch,
  'delete:tag': deleteBranch,

  // Status
  status: statusFixture,

  // Workflow run
  workflow_run: workflowRunCompleted,
  'workflow_run:completed': workflowRunCompleted,
  'workflow_run:requested': workflowRunCompleted,
  'workflow_run:in_progress': workflowRunCompleted,

  // Fork
  fork: forkFixture,

  // Star
  star: starCreated,
  'star:created': starCreated,
  'star:deleted': starCreated,

  // Watch
  watch: watchStarted,
  'watch:started': watchStarted,
};

/**
 * Get default fixture for an event type
 * @param event - Event name (e.g., 'pr:open', 'push', 'comment:created')
 * @returns Fixture payload
 * @throws Error if event is unknown
 */
export function getDefaultFixture(event: string): unknown {
  const normalized = event.toLowerCase().trim();
  const fixture = FIXTURES[normalized];

  if (!fixture) {
    const available = Object.keys(FIXTURES)
      .filter((k, i, arr) => arr.indexOf(k) === i) // Remove duplicates
      .join(', ');
    throw new Error(`Unknown event type: ${event}\n` + `Available events: ${available}`);
  }

  return fixture;
}

/**
 * List all available event names
 */
export function listAvailableEvents(): string[] {
  return [...new Set(Object.keys(FIXTURES))]; // Deduplicate
}
