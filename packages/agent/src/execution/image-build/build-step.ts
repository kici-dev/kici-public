/**
 * Run a job's image build and render it as a run step. The build runs on the
 * AGENT before the sandbox exists, so the runner's IPC pseudo-step channel is
 * unavailable; it uses the agent-side seam of the synthetic `build` / `init` /
 * `global-eval` jobs: step-status pairs plus a log streamer bound to a step index.
 */

import { ExecutionStepStatus, SetupStepType } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { LockJob } from '@kici-dev/engine';
import { resolveJobImageBuildSpec, type JobImageBuildSpec } from './resolve-build-spec.js';

export const CONTAINER_BUILD_STEP_NAME = 'container:build';

/**
 * A large positive constant, because:
 *
 * - `step.status` is `z.number().int().nonnegative()`: a negative index closes
 *   the socket mid-job, and the check-run reporter (`steps[stepIndex]`) and the
 *   dashboard (`stepIndex >= 0`) read one as absent.
 * - It must clear every in-sandbox allocator index; the cache phase tops out
 *   near `stepCount * 3 + 100 + (stepCount + 1) * 1000`, several hundred steps
 *   of headroom.
 *
 * Display order comes from the `container:build` {@link SetupStepType} tag, not
 * this index: readers sort setup pseudo-steps first by type.
 */
export const CONTAINER_BUILD_STEP_INDEX = 1_000_000;

export interface RunJobImageBuildArgs {
  container: LockJob['container'];
  workDir: string;
  jobId: string;
  jobName: string;
  /** Injected so the step logic is testable without a host. */
  build: (spec: JobImageBuildSpec, onLog: (line: string) => void) => Promise<void>;
  /** Every line of build output, in order, for the run log. */
  onLog: (line: string) => void;
  sendStepStatus: (
    name: string,
    state: ExecutionStepStatus,
    data?: Record<string, unknown>,
  ) => void;
  fileExists?: (p: string) => boolean;
}

/**
 * Build the job's declared Dockerfile and return the tag the sandbox runs.
 * Nothing to build (no container, or a finalized image) returns `undefined` and
 * emits no step, so the timeline gains no empty entry.
 */
export async function runJobImageBuild(args: RunJobImageBuildArgs): Promise<string | undefined> {
  const { container, workDir, jobId, jobName, build, onLog, sendStepStatus } = args;

  const spec = resolveJobImageBuildSpec({
    container,
    workDir,
    jobId,
    jobName,
    ...(args.fileExists ? { fileExists: args.fileExists } : {}),
  });
  if (!spec) return undefined;

  // `stepType` rides in `data`, persisted to `execution_steps.step_type` as for
  // the cache pseudo-steps; it sorts this step ahead of the real ones.
  const setup = { stepType: SetupStepType.enum['container:build'] };

  sendStepStatus(CONTAINER_BUILD_STEP_NAME, ExecutionStepStatus.enum.running, setup);
  onLog(`Building ${spec.tag} from ${spec.dockerfilePath}`);

  try {
    await build(spec, onLog);
  } catch (err) {
    const error = toErrorMessage(err);
    onLog(`Build failed: ${error}`);
    sendStepStatus(CONTAINER_BUILD_STEP_NAME, ExecutionStepStatus.enum.failed, {
      ...setup,
      error,
    });
    throw err;
  }

  onLog(`Built ${spec.tag}`);
  sendStepStatus(CONTAINER_BUILD_STEP_NAME, ExecutionStepStatus.enum.success, setup);
  return spec.tag;
}
