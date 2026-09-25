/**
 * Which agents may run a job, beyond what its labels say — above all, which
 * agents may run a job that declares `container:`.
 *
 * A container job runs in one of two places. Either the scaler starts an agent
 * inside the job's image (the agent then runs the steps directly), or an
 * ordinary agent nests the job's container through a container runtime on its
 * host. So an agent not started for the job can run it only when the agent can
 * start containers, and an agent started inside one job's image can run nothing
 * else: any other job would run in an image it never declared.
 *
 * {@link canAgentRunJob} is the one predicate; every dispatch path that hands a
 * queued job to an agent asks it.
 */
import {
  JOB_IMAGE_RUNTIME_LABEL,
  RuntimeFact,
  runtimeLabel,
  ScalerBackendType,
} from '@kici-dev/engine';
import type { ResourceRequest } from '@kici-dev/engine';
import { agentVersionAtLeast } from '../agent/agent-version.js';
import type { LabelSetConfig } from './types.js';

/** What a job asks of the container runtime on the agent that runs it. */
export enum JobContainerNeed {
  /** The job declares no `container:`, so any agent can run it. */
  None = 'none',
  /** The job names an image: the agent pulls it and runs the job inside it. */
  Image = 'image',
  /** The job names a Dockerfile: the agent builds the image, then runs it. */
  Dockerfile = 'dockerfile',
}

/**
 * Classify a job's `container:` declaration.
 *
 * Mirrors the agent, which runs a job in container mode whenever its
 * `container` field is set at all. So any non-empty declaration counts, not
 * only a well-formed `image`: routing a job to an agent that would then nest
 * a container it cannot start is the failure this classification prevents.
 */
export function jobContainerNeed(container: unknown): JobContainerNeed {
  if (!container) return JobContainerNeed.None;
  if (typeof container === 'object') {
    const dockerfile = (container as { dockerfile?: unknown }).dockerfile;
    if (typeof dockerfile === 'string' && dockerfile.length > 0) return JobContainerNeed.Dockerfile;
  }
  return JobContainerNeed.Image;
}

/** The self-reported labels that prove an agent's host can start a container. */
export const CONTAINER_RUNTIME_LABELS: readonly string[] = [
  runtimeLabel(RuntimeFact.enum.docker),
  runtimeLabel(RuntimeFact.enum.podman),
];

/**
 * Whether an agent's registered labels prove it can start a container.
 *
 * The agent reports `kici:runtime:docker` / `kici:runtime:podman` when it finds
 * that runtime's socket at startup. `kici:runtime:container-build` does not
 * count: it says a build CLI is on PATH, and a host can have the CLI and no
 * daemon to run the result on.
 */
export function hasContainerRuntime(labels: Iterable<string>): boolean {
  for (const label of labels) {
    if (CONTAINER_RUNTIME_LABELS.includes(label)) return true;
  }
  return false;
}

/**
 * Whether a spawn this backend makes for a job that names its own image
 * starts the agent INSIDE that image.
 *
 * - The container backend always does: a spawn carrying the job's image runs
 *   that image with the KiCI runtime injected.
 * - The bare-metal backend does only for a label set that declares an `image`
 *   and no `binaryPath`. Such a set has no local binary to start, so it can
 *   only mean job-image mode; every other bare-metal set starts a local agent
 *   that nests the job's container. The backend decides its launch with this
 *   same function, so the two cannot disagree.
 * - Every other backend starts an ordinary agent.
 */
export function spawnsInJobImage(
  backendType: ScalerBackendType,
  labelSet: Pick<LabelSetConfig, 'image' | 'binaryPath'>,
): boolean {
  switch (backendType) {
    case ScalerBackendType.enum.container:
      return true;
    case ScalerBackendType.enum['bare-metal']:
      return labelSet.image !== undefined && !labelSet.binaryPath;
    default:
      return false;
  }
}

/** The facts about one job that decide which scaler agents may run it. */
export interface AgentFitJob {
  /**
   * The queued job's id. An agent the scaler started for a job recognizes
   * that job by it. Absent for a job not yet in the queue, which no agent can
   * have been started for.
   */
  jobId?: string;
  /** The cpu / memory shape the job declares, if any. */
  resources?: ResourceRequest;
  /** What the job's `container:` asks of the agent's host. */
  container: JobContainerNeed;
}

/**
 * The first agent release whose `kici:runtime:docker` / `kici:runtime:podman`
 * labels describe the runtime its job containers actually start on. From it
 * on, an agent with neither label has told the orchestrator it cannot start a
 * container.
 *
 * Earlier releases (0.6.0 to 0.9.x) report runtime labels too, but read
 * `DOCKER_HOST` only as a socket file path, while their container client
 * honours any `DOCKER_HOST`. An agent pointed at `tcp://…` — a Docker-in-Docker
 * sidecar, say — reports no Docker label and runs container jobs fine, so its
 * missing label proves nothing.
 */
export const MIN_RUNTIME_FACTS_AGENT_VERSION = '0.10.0';

/**
 * Whether an agent's runtime labels are proof, so that a missing
 * `kici:runtime:docker` / `kici:runtime:podman` label means no runtime: its
 * version is at least {@link MIN_RUNTIME_FACTS_AGENT_VERSION}, or it reports
 * `kici:runtime:job-image`, which only such a release sends.
 *
 * Any other runtime label is not proof: `kici:runtime:container-build` says a
 * build CLI is on PATH, and an older agent reports it beside a remote
 * `DOCKER_HOST` it does not report.
 */
export function reportsRuntimeFacts(agent: {
  labels: Iterable<string>;
  version: string | null | undefined;
}): boolean {
  for (const label of agent.labels) {
    if (label === JOB_IMAGE_RUNTIME_LABEL) return true;
  }
  return agentVersionAtLeast(agent.version, MIN_RUNTIME_FACTS_AGENT_VERSION);
}

/** What the scaler knows about an agent it started. */
export interface ScalerAgentView {
  /** The job the scaler started the agent for, and whether it runs in that job's image. */
  binding?: { jobId: string; jobImage: boolean };
  /** The scaler pre-spawned the agent for its warm pool. */
  prespawned: boolean;
  /**
   * Whether the agent's fixed shape leaves a job's declared shape unchanged.
   * Always true for an agent the scaler did not pre-spawn.
   */
  shapeFits(resources: ResourceRequest | undefined): boolean;
}

/** The facts about one registered agent that {@link canAgentRunJob} reads. */
export interface FitAgent {
  /** The labels the agent registered with, its self-reported facts included. */
  labels: ReadonlySet<string>;
  /** The agent's self-reported version, or null when it reported none. */
  version: string | null;
  /** The registry records the agent as scaler-started. */
  scalerManaged: boolean;
  /** Present when this coordinator's scaler started the agent. */
  scaler?: ScalerAgentView | undefined;
}

/**
 * The facts `canAgentRunJob` judges a registered agent on: what it reported at
 * registration, and what the scaler that started it (if one did) recorded.
 */
export function fitAgentFor(
  agent: {
    agentId: string;
    labels: ReadonlySet<string>;
    version: string | null;
    scalerManaged: boolean;
  },
  scalerAgentView?: (agentId: string) => ScalerAgentView | undefined,
): FitAgent {
  return {
    labels: agent.labels,
    version: agent.version,
    scalerManaged: agent.scalerManaged,
    scaler: scalerAgentView?.(agent.agentId),
  };
}

/** Whether an agent runs inside a job's own image, by the scaler's record or its own word. */
function isJobImageAgent(agent: FitAgent): boolean {
  return agent.scaler?.binding?.jobImage === true || agent.labels.has(JOB_IMAGE_RUNTIME_LABEL);
}

/**
 * Whether a missing runtime label rules this agent out of container jobs.
 *
 * It does for every scaler agent — the scaler starts a job its own agent when
 * none fits. It does for an operator's own agent only when its runtime labels
 * are proof ({@link reportsRuntimeFacts}): an older agent's silence proves
 * nothing, so the job is left to it.
 */
function runtimeLabelIsProof(agent: FitAgent): boolean {
  return agent.scaler !== undefined || agent.scalerManaged || reportsRuntimeFacts(agent);
}

/**
 * Whether this agent may run this job. Every dispatch path that hands a
 * queued job to an agent asks this one predicate; labels have already matched.
 *
 * In order:
 *
 * - **The agent started for this job** always runs it: the scaler chose that
 *   spawn for this job, image and shape included.
 * - **An agent inside another job's image** runs nothing else. The scaler's
 *   record says so, or the agent itself does (`kici:runtime:job-image`).
 * - **A job that declares `container:`** needs an agent that reports
 *   `kici:runtime:docker` or `kici:runtime:podman`, whenever the missing label
 *   is proof ({@link runtimeLabelIsProof}).
 * - **A pre-spawned (warm) agent** must also match any shape the job declares.
 */
export function canAgentRunJob(agent: FitAgent, job: AgentFitJob): boolean {
  const binding = agent.scaler?.binding;
  // breaks-if-wrong: the agent started in a job's image must still run that job
  if (binding !== undefined && job.jobId !== undefined && job.jobId === binding.jobId) return true;
  // fails-when: an agent started inside one job's image drains an unrelated job
  if (isJobImageAgent(agent)) return false;
  // fails-when: a container job reaches an agent that reports no container
  // runtime, and dies on `connect ENOENT /var/run/docker.sock`
  if (
    job.container !== JobContainerNeed.None &&
    !hasContainerRuntime(agent.labels) &&
    runtimeLabelIsProof(agent)
  ) {
    return false;
  }
  return agent.scaler?.shapeFits(job.resources) ?? true;
}

/**
 * Whether {@link canAgentRunJob} can ever answer false for this agent. The
 * queue drain carries the predicate into its claim only when it can: for an
 * agent that runs any job, the drain keeps its single-statement fast path.
 */
export function agentMayRefuse(agent: FitAgent): boolean {
  if (isJobImageAgent(agent)) return true;
  if (!hasContainerRuntime(agent.labels) && runtimeLabelIsProof(agent)) return true;
  return agent.scaler?.prespawned === true;
}
