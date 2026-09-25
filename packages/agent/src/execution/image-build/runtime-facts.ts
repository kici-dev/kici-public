/**
 * What this agent's own host can do with containers, discovered at startup.
 *
 * The orchestrator cannot answer this. An agent runs on its own machine, and
 * whether that machine has a container runtime is the agent's fact — probing
 * the orchestrator's filesystem answers a different question, and doing so once
 * stranded container jobs that had been running fine, because the probe and the
 * job ran in different places.
 *
 * Reported as `kici:runtime:*` labels, which the register-time scope gate
 * accepts unchallenged as self-reported facts. Deliberately NOT
 * `kici:capability:*` — that prefix grants a privilege and stays token-bound.
 *
 * The same discovery picks the runtime a nested job container starts on
 * ({@link resolveContainerRuntime}), so the label an agent reports and the
 * socket it then uses cannot disagree.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RuntimeFact, runtimeLabel } from '@kici-dev/engine';

/** A socket a container runtime may answer on, and the fact it proves. */
export interface RuntimeSocketCandidate {
  fact: RuntimeFact;
  path: string;
}

/**
 * Where a nested job container is started.
 *
 * `socketPath` is a local socket that exists. `host` is a `DOCKER_HOST` that
 * names something other than a local socket (`tcp://…`, `ssh://…`); its
 * reachability is only known once a request goes out, so a job that reaches a
 * broken one fails with the runtime's own error.
 */
export type ContainerRuntimeEndpoint =
  { fact: RuntimeFact; socketPath: string } | { fact: RuntimeFact; host: string };

export interface DetectRuntimeFactsDeps {
  /** Injected for tests; defaults to a real filesystem check. */
  pathExists?: (p: string) => boolean;
  binaryOnPath?: (bin: string) => boolean;
  /**
   * Injected for tests; defaults to `process.env`. Only `DOCKER_HOST` and
   * `KICI_JOB_IMAGE_AGENT` are read.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to the process uid. */
  uid?: number;
}

const UNIX_SCHEME = 'unix://';

/** The local socket a `DOCKER_HOST` names, or undefined when it names a remote host. */
function dockerHostSocket(dockerHost: string): string | undefined {
  if (dockerHost.startsWith(UNIX_SCHEME)) return dockerHost.slice(UNIX_SCHEME.length);
  // A bare path is a socket too; anything else (tcp://, ssh://, host:port) is remote.
  return dockerHost.startsWith('/') ? dockerHost : undefined;
}

function processUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * The default runtime sockets, in the order the agent would use them, when no
 * `DOCKER_HOST` is set.
 */
export function defaultRuntimeSockets(
  uid: number | undefined = processUid(),
): RuntimeSocketCandidate[] {
  return [
    { fact: RuntimeFact.enum.docker, path: '/var/run/docker.sock' },
    { fact: RuntimeFact.enum.podman, path: '/run/podman/podman.sock' },
    ...(uid !== undefined
      ? [{ fact: RuntimeFact.enum.podman, path: `/run/user/${uid}/podman/podman.sock` }]
      : []),
  ];
}

/**
 * The runtime a nested job container starts on, or null when this host has
 * none the agent can reach.
 *
 * A set `DOCKER_HOST` is authoritative, exactly as it is for the `docker` CLI:
 * a local socket it names must exist, and nothing else is tried in its place.
 * Falling back would quietly start the job on a different daemon than the
 * operator named — a rootful one, say, in place of a rootless one. With no
 * `DOCKER_HOST`, the first default socket that exists is used, so a host that
 * runs only Podman nests on Podman.
 */
export function resolveContainerRuntime(
  deps: DetectRuntimeFactsDeps = {},
): ContainerRuntimeEndpoint | null {
  const pathExists = deps.pathExists ?? existsSync;
  const env = deps.env ?? process.env;
  if (env.DOCKER_HOST) {
    const socketPath = dockerHostSocket(env.DOCKER_HOST);
    if (socketPath === undefined) return { fact: RuntimeFact.enum.docker, host: env.DOCKER_HOST };
    return pathExists(socketPath) ? { fact: RuntimeFact.enum.docker, socketPath } : null;
  }
  const found = defaultRuntimeSockets(deps.uid ?? processUid()).find(({ path }) =>
    pathExists(path),
  );
  return found ? { fact: found.fact, socketPath: found.path } : null;
}

/** Is `bin` executable somewhere on PATH? */
function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, bin)));
}

/**
 * Discover this host's runtime facts.
 *
 * Presence of the socket FILE, not a handshake: registration must not block on
 * a daemon that is slow or wedged, and a job that reaches a broken runtime
 * still fails with the runtime's own error. The label answers "is there a
 * runtime here at all", which is the routing question.
 *
 * `docker` / `podman` are reported only when {@link resolveContainerRuntime}
 * finds a runtime to nest a job container on, so a host the orchestrator routes
 * a container job to by these labels can start it. That is the runtime it
 * resolves, plus every other default socket present. A `DOCKER_HOST` naming a
 * remote host counts as Docker: it has no socket file to look for. A
 * `DOCKER_HOST` naming a socket that is not there reports neither, because the
 * sandbox will not fall back from it.
 */
export function detectRuntimeFacts(deps: DetectRuntimeFactsDeps = {}): RuntimeFact[] {
  const pathExists = deps.pathExists ?? existsSync;
  const hasBinary = deps.binaryOnPath ?? onPath;

  const facts = new Set<RuntimeFact>();
  const runtime = resolveContainerRuntime(deps);
  if (runtime) {
    facts.add(runtime.fact);
    for (const { fact, path } of defaultRuntimeSockets(deps.uid ?? processUid())) {
      if (pathExists(path)) facts.add(fact);
    }
  }

  // Building needs the CLI, not the socket. A containerized agent handed only a
  // mounted socket can RUN a job container and cannot BUILD one, so these are
  // two separate facts rather than one.
  if (hasBinary('docker') || hasBinary('podman')) {
    facts.add(RuntimeFact.enum['container-build']);
  }

  // The scaler started this agent inside one job's own image
  // (`KICI_JOB_IMAGE_AGENT=1`, the same setting that makes it run steps
  // directly). Reported so the orchestrator gives it no other job even when
  // its own record of the spawn is gone.
  if ((deps.env ?? process.env).KICI_JOB_IMAGE_AGENT === '1') {
    facts.add(RuntimeFact.enum['job-image']);
  }

  return [...facts];
}

/** The `kici:runtime:*` labels this host should register with. */
export function runtimeFactLabels(deps: DetectRuntimeFactsDeps = {}): string[] {
  return detectRuntimeFacts(deps).map(runtimeLabel);
}
