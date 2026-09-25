/**
 * The workspace of an evaluation job of a global workflow: a deferred init job,
 * a generator evaluation, or a pre-run global eval round.
 *
 * It is the layout every other job of that workflow uses. The workflow
 * repository is cloned at the registration's commit into `workflow/`, and its
 * `.kici/` is what the evaluation loads. The source repository the event came
 * from is cloned into `source/`, where a filter, a generator or a dynamic field
 * reads it. The clone goes through the same request builder and the same
 * `cloneJobRepos` the host checkout and the sandbox runner use, so the three
 * cannot disagree about which repository each credential opens.
 *
 * The dependency tarball and the cached source pack both carry the workflow
 * repository's `.kici/`, so both restore into `workflow/` and never into the
 * source tree.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { JobDispatch } from '@kici-dev/engine';
import { cloneJobRepos } from '../checkout/clone-job-repos.js';
import { buildCloneRequest } from './sandbox/fork-runner.js';
import { restoreDeps, excludeScratchFromGit } from './dep-restore.js';
import { restoreSource } from './source-restore.js';
import { installDeps } from './dep-installer.js';
import { globalWorkspaceLayout, type JobWorkspaceLayout } from './job-workspace-layout.js';
import { cloneDurationSeconds } from '../metrics/prometheus.js';

export interface GlobalEvalWorkspaceArgs {
  dispatch: JobDispatch;
  workDir: string;
  log: (msg: string) => void;
  /** How an inline dependency install runs when no dependency tarball was dispatched. */
  install: { baseEnv: NodeJS.ProcessEnv; allowInstallScripts: boolean | undefined };
  /**
   * Runs on the workflow checkout after the clone and before the dependencies:
   * a test run's overlay, which may change `.kici/package.json`.
   */
  afterClone?: (workflowDir: string) => Promise<void>;
  /** Told the `.kici/` directory and whether it declares dependencies, before the install decision. */
  onDepsCheck?: (kiciDir: string, hasPackageJson: boolean) => void;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone both repositories, then materialize the workflow repository's
 * dependencies and cached source over its checkout. Returns the layout it
 * filled.
 */
export async function materializeGlobalEvalWorkspace(
  args: GlobalEvalWorkspaceArgs,
): Promise<JobWorkspaceLayout> {
  const { dispatch, workDir, log } = args;
  const layout = globalWorkspaceLayout(workDir);
  const { workflowDir } = layout;

  const cloneStart = Date.now();
  await cloneJobRepos(
    buildCloneRequest(dispatch),
    { workDir, ...layout },
    {
      isGlobal: true,
      log,
      excludeScratchFromGit,
    },
  );
  cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);

  if (args.afterClone) await args.afterClone(workflowDir);

  if (dispatch.depsUrl) {
    log('Restoring dependencies from cache');
    await restoreDeps(workflowDir, dispatch.depsUrl, dispatch.depsHash);
  }
  if (dispatch.sourceTarUrl) {
    log('Restoring workflow source from cached tarball');
    await restoreSource(workflowDir, dispatch.sourceTarUrl, dispatch.sourceTarDigest);
  }
  // `@kici-dev/sdk` must resolve under `.kici/node_modules/` when the module is imported.
  const kiciDir = join(workflowDir, '.kici');
  const hasPackageJson = await fileExists(join(kiciDir, 'package.json'));
  args.onDepsCheck?.(kiciDir, hasPackageJson);
  if (!dispatch.depsUrl && hasPackageJson) {
    log('Installing dependencies locally');
    await installDeps(kiciDir, {
      npmRegistries: dispatch.npmRegistries,
      installEnvSecrets: dispatch.installEnvSecrets,
      jobIdShort: dispatch.jobId.slice(0, 8),
      baseEnv: args.install.baseEnv,
      allowInstallScripts: args.install.allowInstallScripts,
    });
  }
  return layout;
}
