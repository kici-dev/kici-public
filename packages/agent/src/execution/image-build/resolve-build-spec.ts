/**
 * Turns a job's `container.dockerfile` into an absolute, checked build spec.
 * Pure on purpose, so the anchoring, escape refusal and tag shape are
 * unit-tested without a container runtime; the host half is `build-engine.ts`.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LockJob } from '@kici-dev/engine';

export interface JobImageBuildSpec {
  /** Absolute. */
  dockerfilePath: string;
  /** Absolute. */
  contextDir: string;
  target?: string;
  /** Never secret material. */
  args: Record<string, string>;
  /** The tag the sandbox then runs. */
  tag: string;
  /** Labels that put the image in reach of the leak sweep. */
  labels: Record<string, string>;
}

/**
 * Anchors a repo-relative path under `workDir`. The SDK refuses escapes too, but
 * a lock file is repo content: a hand-edited lock could carry `../../etc/shadow`
 * as a build context the author never wrote.
 */
function anchor(workDir: string, p: string, field: string): string {
  if (isAbsolute(p)) {
    throw new Error(`container.${field} must stay inside the repository (got: ${p})`);
  }
  const abs = resolve(workDir, p);
  const rel = relative(workDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`container.${field} must stay inside the repository (got: ${p})`);
  }
  return abs;
}

/** A job name may carry spaces, slashes or parentheses, none of which a tag accepts. */
function tagSafe(value: string, maxLength: number): string {
  const slug = value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug.slice(0, maxLength) : 'job';
}

/**
 * The job id makes the tag unique: the truncated name alone collides for matrix
 * legs (`build (os=linux)` / `build (os=darwin)`) once the shared prefix exceeds
 * the limit, and a leg could then run its sibling's image.
 */
function buildTagFor(jobName: string, jobId: string): string {
  return `kici-build:${tagSafe(jobName, 48)}-${tagSafe(jobId, 12)}`;
}

export interface ResolveJobImageBuildSpecArgs {
  container: LockJob['container'];
  /** The cloned tree; every path resolves inside it. */
  workDir: string;
  jobId: string;
  jobName: string;
  /** Injected for tests; defaults to a real filesystem check. */
  fileExists?: (p: string) => boolean;
}

/** `undefined` (the common case) when the job has no container or names a finalized image. */
export function resolveJobImageBuildSpec(
  args: ResolveJobImageBuildSpecArgs,
): JobImageBuildSpec | undefined {
  const { container, workDir, jobId, jobName } = args;
  const fileExists = args.fileExists ?? existsSync;

  if (!container || typeof container === 'string') return undefined;
  const { dockerfile } = container;
  if (typeof dockerfile !== 'string' || dockerfile.length === 0) return undefined;

  const dockerfilePath = anchor(workDir, dockerfile, 'dockerfile');
  const contextDir =
    container.context === undefined ? workDir : anchor(workDir, container.context, 'context');

  // Fails here, not as the CLI's "failed to read dockerfile" three layers down.
  if (!fileExists(dockerfilePath)) {
    throw new Error(
      `container.dockerfile '${dockerfile}' does not exist in the repository ` +
        `(looked at ${dockerfilePath})`,
    );
  }

  return {
    dockerfilePath,
    contextDir,
    ...(container.target !== undefined ? { target: container.target } : {}),
    args: { ...(container.args ?? {}) },
    tag: buildTagFor(jobName, jobId),
    labels: { 'kici-managed': 'true', 'kici-job-id': jobId },
  };
}
