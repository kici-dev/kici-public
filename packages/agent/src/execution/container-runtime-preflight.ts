/**
 * Before nesting a container job, check this host has a container runtime.
 * Otherwise the job dies inside the client on `connect ENOENT
 * /var/run/docker.sock`, naming neither the job's need nor the agent's labels.
 * The orchestrator keeps container jobs off such agents where it can, but never
 * refuses an operator's own agent one, so this message is what the job fails
 * with.
 */
import Docker from 'dockerode';
import { RuntimeFact, runtimeLabel } from '@kici-dev/engine';
import {
  defaultRuntimeSockets,
  resolveContainerRuntime,
  type ContainerRuntimeEndpoint,
  type DetectRuntimeFactsDeps,
} from './image-build/runtime-facts.js';

/** A container job reached an agent with no container runtime to start it on. */
export class ContainerRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRuntimeUnavailableError';
  }
}

/** The labels that route a container job to a host that can start it. */
const RUNTIME_LABELS = [
  runtimeLabel(RuntimeFact.enum.docker),
  runtimeLabel(RuntimeFact.enum.podman),
];

/** What the job asked to run in, for the message: its image, or its Dockerfile. */
function describeJobContainer(container: unknown): string {
  if (typeof container === 'string') return `image ${container}`;
  if (container && typeof container === 'object') {
    const { image, dockerfile } = container as { image?: unknown; dockerfile?: unknown };
    if (typeof image === 'string') return `image ${image}`;
    if (typeof dockerfile === 'string') return `an image built from ${dockerfile}`;
  }
  return 'a container';
}

/** Where the agent looked for a runtime, for the message. */
function whereItLooked(deps: DetectRuntimeFactsDeps): string {
  const dockerHost = (deps.env ?? process.env).DOCKER_HOST;
  if (dockerHost) return `DOCKER_HOST is ${dockerHost}, and no socket exists there`;
  const paths = defaultRuntimeSockets(deps.uid).map(({ path }) => path);
  return `no Docker or Podman socket exists at ${paths.join(', ')}, and DOCKER_HOST is not set`;
}

/** The failure message for a container job on an agent with no runtime. */
export function missingRuntimeMessage(args: {
  container: unknown;
  agentLabels: readonly string[];
  deps?: DetectRuntimeFactsDeps;
}): string {
  const labels = args.agentLabels.length > 0 ? args.agentLabels.join(', ') : '(none)';
  return (
    `This job runs in a container (${describeJobContainer(args.container)}), but this agent ` +
    `has no container runtime to start it on: ${whereItLooked(args.deps ?? {})}. ` +
    `Agent labels: ${labels}. ` +
    `Run container jobs on an agent that reports ${RUNTIME_LABELS.join(' or ')}, ` +
    `or install Docker or Podman on this host.`
  );
}

/**
 * The runtime this job's container starts on. `resolve` is a test injection.
 *
 * @throws ContainerRuntimeUnavailableError when the host has none, with a
 *   message naming the missing runtime and the agent's labels.
 */
export function requireContainerRuntime(args: {
  container: unknown;
  agentLabels: readonly string[];
  resolve?: () => ContainerRuntimeEndpoint | null;
  deps?: DetectRuntimeFactsDeps;
}): ContainerRuntimeEndpoint {
  const runtime = (args.resolve ?? (() => resolveContainerRuntime(args.deps)))();
  // fails-when: a container job on a host with no socket reaches the client
  // and dies on a bare `connect ENOENT`
  if (runtime) return runtime;
  throw new ContainerRuntimeUnavailableError(missingRuntimeMessage(args));
}

/**
 * A local socket is passed explicitly, so a Podman-only host is not reached on
 * the client's Docker default. A remote `DOCKER_HOST` (and its TLS settings)
 * the client reads from the environment itself.
 */
export function dockerClientFor(runtime: ContainerRuntimeEndpoint): Docker {
  return 'socketPath' in runtime ? new Docker({ socketPath: runtime.socketPath }) : new Docker();
}
