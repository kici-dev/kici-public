/**
 * Turn a job's `container.dockerfile` into an absolute, checked build spec.
 *
 * Pure on purpose. Every rule that decides what gets built — the anchoring, the
 * escape refusal, the tag shape — is decided here and unit-tested without a
 * container runtime anywhere near it. The half that needs a host lives in
 * `build-engine.ts`.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LockJob } from '@kici-dev/engine';

/** Everything the build CLI needs, resolved and checked. */
export interface JobImageBuildSpec {
  /** Absolute path to the Dockerfile. */
  dockerfilePath: string;
  /** Absolute build-context directory. */
  contextDir: string;
  /** Build stage to stop at, when the job named one. */
  target?: string;
  /** Build arguments. Plain strings — never secret material. */
  args: Record<string, string>;
  /** Tag the built image gets, and the sandbox then runs. */
  tag: string;
  /** Labels that put the image in reach of the leak sweep. */
  labels: Record<string, string>;
}

/**
 * Anchor a repo-relative path under `workDir`, refusing anything that leaves it.
 *
 * The SDK already refused these at workflow-definition time. Refusing them AGAIN
 * here is the point rather than a duplication: a lock file is repo content, so a
 * hand-edited lock could carry `../../etc/shadow` and reach a build context that
 * the author never wrote.
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

/**
 * Reduce a value to a container-runtime tag component.
 *
 * A job name is author-supplied and may carry spaces, slashes or parentheses,
 * none of which a tag accepts.
 */
function tagSafe(value: string, maxLength: number): string {
  const slug = value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug.slice(0, maxLength) : 'job';
}

/**
 * Tag for a job's built image: a readable name, made unique by the job id.
 *
 * The job id is what guarantees uniqueness, and it is not decoration. The name
 * alone is truncated to fit a tag, and MATRIX LEGS of one job share a long
 * prefix and differ only in the suffix — `build (os=linux)` and
 * `build (os=darwin)` collide the moment the shared part exceeds the limit.
 * Two legs of one run on one host would then race for one tag, and a leg could
 * run its sibling's image.
 */
function buildTagFor(jobName: string, jobId: string): string {
  return `kici-build:${tagSafe(jobName, 48)}-${tagSafe(jobId, 12)}`;
}

export interface ResolveJobImageBuildSpecArgs {
  container: LockJob['container'];
  /** The cloned tree. Every path resolves against this and must stay inside it. */
  workDir: string;
  jobId: string;
  jobName: string;
  /** Injected for tests; defaults to a real filesystem check. */
  fileExists?: (p: string) => boolean;
}

/**
 * Resolve the build spec for a job, or `undefined` when the job builds nothing.
 *
 * `undefined` is the common case and is not a failure: a job with no container,
 * or one that names a finalized image, has nothing to build.
 */
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

  // Named before the build starts rather than surfacing as the CLI's own
  // "failed to read dockerfile" three layers down.
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
