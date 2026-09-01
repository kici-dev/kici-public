/**
 * Run a job's image build and render it as a step in the run.
 *
 * The build happens on the AGENT, before the sandbox exists, so it cannot use
 * the runner's IPC pseudo-step channel that the cache phase uses — that channel
 * belongs to a process which has not started yet. It uses the agent-side seam
 * the synthetic `build` / `init` / `global-eval` jobs already use: a step-status
 * pair plus a log streamer bound to a step index.
 */

import { ExecutionStepStatus, SetupStepType } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { LockJob } from '@kici-dev/engine';
import { resolveJobImageBuildSpec, type JobImageBuildSpec } from './resolve-build-spec.js';

/** Step name the run timeline shows for a job's image build. */
export const CONTAINER_BUILD_STEP_NAME = 'container:build';

/**
 * Step index the image build reports under.
 *
 * A large positive constant, for two reasons that are easy to trip over:
 *
 * - `step.status` carries `z.number().int().nonnegative()`, so a negative index
 *   is not available. An agent that sent one to an OLDER orchestrator would be
 *   disconnected mid-job (an invalid message closes the socket), and two
 *   consumers read a negative index as absent — the check-run reporter writes
 *   `steps[stepIndex]`, and the dashboard gates log fetching on `stepIndex >= 0`.
 * - It must clear every index the in-sandbox allocators reach. The cache phase
 *   tops out around `stepCount * 3 + 100 + (stepCount + 1) * 1000`, so this
 *   clears a job of several hundred steps with room to spare.
 *
 * DISPLAY ORDER does not come from this index. The step is tagged with the
 * `container:build` {@link SetupStepType}, and readers sort setup pseudo-steps
 * ahead of the real steps by type — so the build renders where it ran, first,
 * without a negative index or a protocol change.
 */
export const CONTAINER_BUILD_STEP_INDEX = 1_000_000;

export interface RunJobImageBuildArgs {
  container: LockJob['container'];
  workDir: string;
  jobId: string;
  jobName: string;
  /** Perform the build. Injected so the step logic is testable without a host. */
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
 * Build the job's image when it declared a Dockerfile, and return the tag the
 * sandbox should run.
 *
 * Returns `undefined` when there is nothing to build — a job with no container,
 * or one that names a finalized image. That is the common case and emits no
 * step at all: a run timeline should not grow an empty entry for work that did
 * not happen.
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

  // `stepType` rides in `data` — the free-form channel the tracker persists to
  // `execution_steps.step_type`, and the same one the cache pseudo-steps use.
  // It is what makes this step sort ahead of the real ones.
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
