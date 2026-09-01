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
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RuntimeFact, runtimeLabel } from '@kici-dev/engine';

/** Sockets a container runtime answers on, in the order the agent would use them. */
function candidateSockets(): Array<{ fact: RuntimeFact; path: string }> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const dockerHost = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '');
  return [
    // An explicit DOCKER_HOST wins, and is what `new Docker()` would use.
    ...(dockerHost ? [{ fact: RuntimeFact.enum.docker, path: dockerHost }] : []),
    { fact: RuntimeFact.enum.docker, path: '/var/run/docker.sock' },
    { fact: RuntimeFact.enum.podman, path: '/run/podman/podman.sock' },
    ...(uid !== undefined
      ? [{ fact: RuntimeFact.enum.podman, path: `/run/user/${uid}/podman/podman.sock` }]
      : []),
  ];
}

/** Is `bin` executable somewhere on PATH? */
function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, bin)));
}

export interface DetectRuntimeFactsDeps {
  /** Injected for tests; defaults to a real filesystem check. */
  pathExists?: (p: string) => boolean;
  binaryOnPath?: (bin: string) => boolean;
}

/**
 * Discover this host's runtime facts.
 *
 * Presence of the socket FILE, not a handshake: registration must not block on
 * a daemon that is slow or wedged, and a job that reaches a broken runtime
 * still fails with the runtime's own error. The label answers "is there a
 * runtime here at all", which is the routing question.
 */
export function detectRuntimeFacts(deps: DetectRuntimeFactsDeps = {}): RuntimeFact[] {
  const pathExists = deps.pathExists ?? existsSync;
  const hasBinary = deps.binaryOnPath ?? onPath;

  const facts = new Set<RuntimeFact>();
  for (const { fact, path } of candidateSockets()) {
    if (pathExists(path)) facts.add(fact);
  }

  // Building needs the CLI, not the socket. A containerized agent handed only a
  // mounted socket can RUN a job container and cannot BUILD one, so these are
  // two separate facts rather than one.
  if (hasBinary('docker') || hasBinary('podman')) {
    facts.add(RuntimeFact.enum['container-build']);
  }

  return [...facts];
}

/** The `kici:runtime:*` labels this host should register with. */
export function runtimeFactLabels(deps: DetectRuntimeFactsDeps = {}): string[] {
  return detectRuntimeFacts(deps).map(runtimeLabel);
}
