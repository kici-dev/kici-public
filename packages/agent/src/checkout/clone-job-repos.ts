/**
 * Clone a job's repositories — from the host or from inside the sandbox.
 *
 * This used to live only inside the workflow runner, which meant the clone
 * always happened wherever the runner ran: for a container job, inside the
 * customer's image, which therefore had to ship git. Extracting it lets the
 * AGENT clone on the host and copy the tree in, so the image needs no git —
 * and it puts clone-time credentials on the host, where the credential helper
 * already works, rather than needing a route into a container hardened with
 * `CapDrop: ALL`.
 *
 * Both callers run the SAME code: the runner keeps calling it for bare-metal
 * and for the legacy container path, and the agent calls it for a host-side
 * checkout. A second implementation would be two subtly different clones.
 */

import { mkdir } from 'node:fs/promises';
import { gitClone, type GitAuth } from './git-clone.js';

/** The clone-relevant slice of a job execution request. */
export interface CloneJobReposRequest {
  repoUrl: string;
  ref: string;
  sha: string;
  token?: string | undefined;
  sourceAuth?: GitAuth | undefined;
  workflowAuth?: GitAuth | undefined;
  workflowRepoUrl?: string | undefined;
  workflowRef?: string | undefined;
  workflowSha?: string | undefined;
  checkout?: boolean | undefined;
  fullRepo?: boolean | undefined;
  credentialHelperPath?: string | undefined;
}

export interface CloneJobReposDirs {
  workDir: string;
  workflowDir: string;
  sourceDir: string;
}

export interface CloneJobReposDeps {
  /** Whether this job runs a global workflow (workflow repo + source repo). */
  isGlobal: boolean;
  /** Progress sink. The runner routes this to IPC; the agent to its logger. */
  log: (line: string) => void;
  /** Hide dep-restore scratch dirs from `git status` in a cloned tree. */
  excludeScratchFromGit: (dir: string) => Promise<void>;
}

/**
 * Clone whatever this job needs, or nothing.
 *
 * Three modes, unchanged from where this logic used to live: full-repo overlay
 * (no clone), global dual-clone (workflow repo + source repo), and the ordinary
 * single-repo clone.
 */
export async function cloneJobRepos(
  request: CloneJobReposRequest,
  dirs: CloneJobReposDirs,
  deps: CloneJobReposDeps,
): Promise<void> {
  if (request.checkout === false) return;

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
      token: workflowAuth ? undefined : request.token,
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
      token: sourceAuth ? undefined : request.token,
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
    token: request.sourceAuth ? undefined : request.token,
    ...helper,
  });
  await deps.excludeScratchFromGit(dirs.workDir);
  deps.log('Clone complete');
}
