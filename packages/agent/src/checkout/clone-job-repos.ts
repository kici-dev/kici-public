/**
 * Clone a job's repositories, from the host or from inside the sandbox.
 *
 * A host-side clone lets the agent copy the tree into a container job, so the
 * customer's image needs no git, and clone-time credentials stay on the host
 * where the credential helper works, with no route into a `CapDrop: ALL`
 * container. The runner calls the same code for bare-metal and the legacy
 * container path: a second implementation would be two subtly different clones.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import type { LockCheckoutOptions } from '@kici-dev/engine';
import { gitClone, type GitAuth } from './git-clone.js';

/** The clone-relevant slice of a job execution request. */
export interface CloneJobReposRequest {
  repoUrl: string;
  ref: string;
  sha: string;
  sourceAuth?: GitAuth | undefined;
  workflowAuth?: GitAuth | undefined;
  workflowRepoUrl?: string | undefined;
  workflowRef?: string | undefined;
  workflowSha?: string | undefined;
  checkout?: boolean | undefined;
  /** Clone depth and tag policy for the job's repo; unset clones at depth 1 with git's default tags. */
  checkoutOptions?: LockCheckoutOptions | undefined;
  /** The orchestrator dispatched a cached `.kici/` source tarball. */
  sourceCached?: boolean | undefined;
  fullRepo?: boolean | undefined;
  credentialHelperPath?: string | undefined;
}

export interface CloneJobReposDirs {
  workDir: string;
  workflowDir: string;
  sourceDir: string;
}

export interface CloneJobReposDeps {
  /** A global workflow clones the workflow repo + the source repo. */
  isGlobal: boolean;
  /** Progress sink. The runner routes this to IPC; the agent to its logger. */
  log: (line: string) => void;
  /** Hide dep-restore scratch dirs from `git status` in a cloned tree. */
  excludeScratchFromGit: (dir: string) => Promise<void>;
}

/**
 * A `checkout: false` job gets no clone, but the runner still loads its workflow
 * from `.kici/`. Nothing is fetched when the tree is already there (in-place,
 * host checkout), when the overlay provides it (full-repo), or when the
 * orchestrator dispatched the cached source. Otherwise only `.kici/` is copied
 * out of a throwaway depth-1 clone of the repo that carries it.
 */
async function prepareWithoutCheckout(
  request: CloneJobReposRequest,
  dirs: CloneJobReposDirs,
  deps: CloneJobReposDeps,
): Promise<void> {
  await mkdir(dirs.workDir, { recursive: true });
  if (request.fullRepo || existsSync(join(dirs.workflowDir, '.kici'))) return;
  if (request.sourceCached) {
    deps.log(
      'checkout: false — skipping the clone; .kici/ restores from the cached workflow source',
    );
    return;
  }

  const workflowRepo = deps.isGlobal
    ? {
        repoUrl: request.workflowRepoUrl!,
        ref: request.workflowRef ?? '',
        sha: request.workflowSha ?? '',
        gitAuth: request.workflowAuth ?? request.sourceAuth,
      }
    : { repoUrl: request.repoUrl, ref: request.ref, sha: request.sha, gitAuth: request.sourceAuth };
  const tmp = await makeTempDir('src');
  try {
    const cloneDir = join(tmp.path, 'repo');
    await gitClone({ ...workflowRepo, workDir: cloneDir, depth: 1 });
    await mkdir(dirs.workflowDir, { recursive: true });
    await cp(join(cloneDir, '.kici'), join(dirs.workflowDir, '.kici'), { recursive: true });
  } finally {
    await tmp.cleanup().catch(() => {});
  }
  deps.log(
    'checkout: false — this orchestrator caches no workflow source, so only .kici/ was fetched',
  );
}

/**
 * Clone whatever this job needs: nothing (full-repo overlay), at most `.kici/`
 * (`checkout: false`), a global dual-clone, or the ordinary single-repo clone.
 * The job's checkout options set the depth and tags of the job's own repo: the
 * single repo, or a global workflow's source repo.
 */
export async function cloneJobRepos(
  request: CloneJobReposRequest,
  dirs: CloneJobReposDirs,
  deps: CloneJobReposDeps,
): Promise<void> {
  if (request.checkout === false) {
    await prepareWithoutCheckout(request, dirs, deps);
    return;
  }

  const jobCheckout = {
    depth: request.checkoutOptions?.fetchDepth ?? 1,
    fetchTags: request.checkoutOptions?.fetchTags,
  };
  const helper = request.credentialHelperPath
    ? { credentialHelperPath: request.credentialHelperPath }
    : {};

  if (request.fullRepo) {
    await mkdir(dirs.workDir, { recursive: true });
    deps.log('Full-repo mode: skipping git clone (workspace from overlay tarball)');
    return;
  }

  if (deps.isGlobal) {
    await mkdir(dirs.workflowDir, { recursive: true });
    await mkdir(dirs.sourceDir, { recursive: true });

    const workflowAuth = request.workflowAuth ?? request.sourceAuth;
    const sourceAuth = request.sourceAuth ?? request.workflowAuth;

    deps.log(
      `Global workflow: cloning workflow repo ${request.workflowRepoUrl} ` +
        `ref=${request.workflowRef} into ${dirs.workflowDir}`,
    );
    await gitClone({
      repoUrl: request.workflowRepoUrl!,
      ref: request.workflowRef ?? '',
      sha: request.workflowSha ?? '',
      workDir: dirs.workflowDir,
      gitAuth: workflowAuth,
      ...helper,
    });
    // `.kici/` lives in the WORKFLOW repo for a global workflow, so only this
    // clone gets the exclude rule.
    await deps.excludeScratchFromGit(dirs.workflowDir);

    deps.log(
      `Global workflow: cloning source repo ${request.repoUrl} ` +
        `ref=${request.ref} into ${dirs.sourceDir}`,
    );
    await gitClone({
      repoUrl: request.repoUrl,
      ref: request.ref,
      sha: request.sha,
      workDir: dirs.sourceDir,
      gitAuth: sourceAuth,
      ...jobCheckout,
      ...helper,
    });
    deps.log('Dual-clone complete');
    return;
  }

  deps.log(`Cloning ${request.repoUrl} ref=${request.ref} into ${dirs.workDir}`);
  await gitClone({
    repoUrl: request.repoUrl,
    ref: request.ref,
    sha: request.sha,
    workDir: dirs.workDir,
    gitAuth: request.sourceAuth,
    ...jobCheckout,
    ...helper,
  });
  await deps.excludeScratchFromGit(dirs.workDir);
  deps.log('Clone complete');
}
