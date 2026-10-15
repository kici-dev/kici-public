/**
 * Workspace of a global workflow's evaluation job (deferred init job, generator
 * evaluation, or pre-run eval round), in the same layout as its other jobs.
 *
 * The workflow repository is cloned at the registration's commit into
 * `workflow/`, whose `.kici/` the evaluation loads; the event's source
 * repository goes into `source/`, read by filters, generators and dynamic
 * fields. The clone uses the same request builder and `cloneJobRepos` as the
 * host checkout and the sandbox runner, so the three cannot disagree on which
 * repository each credential opens.
 *
 * The dependency tarball and cached source pack both carry the workflow repo's
 * `.kici/`, so both restore into `workflow/`, never the source tree. A failed
 * dependency restore falls back to installing into `workflow/.kici/`.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { JobDispatch } from '@kici-dev/engine';
import { cloneJobRepos } from '../checkout/clone-job-repos.js';
import { buildCloneRequest } from './sandbox/fork-runner.js';
import { excludeScratchFromGit } from './dep-restore.js';
import { tryRestoreDeps } from './dep-restore-fallback.js';
import { restoreSource } from './source-restore.js';
import { installDeps } from './dep-installer.js';
import { globalWorkspaceLayout, type JobWorkspaceLayout } from './job-workspace-layout.js';
import { cloneDurationSeconds } from '../metrics/prometheus.js';

export interface GlobalEvalWorkspaceArgs {
  dispatch: JobDispatch;
  workDir: string;
  log: (msg: string) => void;
  /** Inline dependency install settings, used when no tarball was restored. */
  install: { baseEnv: NodeJS.ProcessEnv; allowInstallScripts: boolean | undefined };
  /** A test run's overlay, after the clone and before deps; may change `.kici/package.json`. */
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

/** Clone both repositories, then restore deps and cached source over the workflow checkout. */
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

  // A failed restore leaves `depsRestored` false and the install below runs.
  let depsRestored = false;
  if (dispatch.depsUrl) {
    log('Restoring dependencies from cache');
    depsRestored = await tryRestoreDeps({
      workDir: workflowDir,
      depsUrl: dispatch.depsUrl,
      depsHash: dispatch.depsHash,
      log,
    });
  }
  if (dispatch.sourceTarUrl) {
    log('Restoring workflow source from cached tarball');
    await restoreSource(workflowDir, dispatch.sourceTarUrl, dispatch.sourceTarDigest);
  }
  // `@kici-dev/sdk` must resolve under `.kici/node_modules/` when the module is imported.
  const kiciDir = join(workflowDir, '.kici');
  const hasPackageJson = await fileExists(join(kiciDir, 'package.json'));
  args.onDepsCheck?.(kiciDir, hasPackageJson);
  if (!depsRestored && hasPackageJson) {
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
