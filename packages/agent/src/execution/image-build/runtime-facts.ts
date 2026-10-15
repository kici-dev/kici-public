/**
 * What this agent's own host can do with containers, discovered at startup.
 *
 * Only the agent can answer this: probing the orchestrator's filesystem asks
 * about a different machine, and stranded working container jobs when tried.
 *
 * Reported as `kici:runtime:*` labels, which the register-time scope gate
 * accepts as self-reported facts. Deliberately NOT `kici:capability:*`: that
 * prefix grants a privilege and stays token-bound.
 *
 * The same discovery picks the nested job container's runtime
 * ({@link resolveContainerRuntime}), so the reported label and the socket used
 * cannot disagree.
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
 * Where a nested job container is started. `socketPath` is an existing local
 * socket; `host` is a non-socket `DOCKER_HOST` (`tcp://…`, `ssh://…`) whose
 * reachability is known only on first request, so a broken one fails the job
 * with the runtime's own error.
 */
export type ContainerRuntimeEndpoint =
  { fact: RuntimeFact; socketPath: string } | { fact: RuntimeFact; host: string };

export interface DetectRuntimeFactsDeps {
  /** Test injection points below; each defaults to the real host. */
  pathExists?: (p: string) => boolean;
  binaryOnPath?: (bin: string) => boolean;
  /** Only `DOCKER_HOST` and `KICI_JOB_IMAGE_AGENT` are read. */
  env?: Readonly<Record<string, string | undefined>>;
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

/** The no-`DOCKER_HOST` runtime sockets, in preference order. */
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
 * A set `DOCKER_HOST` is authoritative, as for the `docker` CLI: a socket it
 * names must exist, with no fallback, which would quietly use a daemon the
 * operator did not name (e.g. rootful in place of rootless). Otherwise the
 * first existing default socket wins, so a Podman-only host nests on Podman.
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
 * Discover this host's runtime facts from socket FILE presence, not a
 * handshake: registration must not block on a slow or wedged daemon, and the
 * routing question is only "is there a runtime here at all".
 *
 * `docker` / `podman` are reported only when {@link resolveContainerRuntime}
 * finds a runtime, so a host routed a container job by these labels can start
 * it: the resolved runtime plus every other default socket present. A remote
 * `DOCKER_HOST` counts as Docker; a `DOCKER_HOST` socket that is missing
 * reports neither, since the sandbox will not fall back from it.
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

  // Building needs the CLI, not the socket: an agent handed only a mounted
  // socket can RUN a job container but not BUILD one.
  if (hasBinary('docker') || hasBinary('podman')) {
    facts.add(RuntimeFact.enum['container-build']);
  }

  // The scaler started this agent inside one job's own image (the same setting
  // makes it run steps directly). Reported so the orchestrator gives it no
  // other job even when its own record of the spawn is gone.
  if ((deps.env ?? process.env).KICI_JOB_IMAGE_AGENT === '1') {
    facts.add(RuntimeFact.enum['job-image']);
  }

  return [...facts];
}

/** The `kici:runtime:*` labels this host should register with. */
export function runtimeFactLabels(deps: DetectRuntimeFactsDeps = {}): string[] {
  return detectRuntimeFacts(deps).map(runtimeLabel);
}
