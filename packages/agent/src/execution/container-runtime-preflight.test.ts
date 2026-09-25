import { describe, it, expect } from 'vitest';
import { RuntimeFact } from '@kici-dev/engine';
import {
  ContainerRuntimeUnavailableError,
  dockerClientFor,
  missingRuntimeMessage,
  requireContainerRuntime,
} from './container-runtime-preflight.js';

const noRuntime = { pathExists: () => false, env: {}, uid: 1000 };

describe('requireContainerRuntime', () => {
  it('returns the runtime the host has', () => {
    const runtime = { fact: RuntimeFact.enum.docker, socketPath: '/var/run/docker.sock' };

    // breaks-if-wrong: a host with a runtime still runs its container job
    expect(
      requireContainerRuntime({
        container: 'python:3.12',
        agentLabels: [],
        resolve: () => runtime,
      }),
    ).toBe(runtime);
  });

  it('refuses a host with none, naming the runtime and the agent labels', () => {
    // fails-when: the job reaches the container client and dies on a bare
    // `connect ENOENT /var/run/docker.sock`
    expect(() =>
      requireContainerRuntime({
        container: { image: 'python:3.12-bookworm' },
        agentLabels: ['linux', 'kici:agent:container'],
        deps: noRuntime,
      }),
    ).toThrow(ContainerRuntimeUnavailableError);

    const message = missingRuntimeMessage({
      container: { image: 'python:3.12-bookworm' },
      agentLabels: ['linux', 'kici:agent:container'],
      deps: noRuntime,
    });
    expect(message).toBe(
      'This job runs in a container (image python:3.12-bookworm), but this agent has no ' +
        'container runtime to start it on: no Docker or Podman socket exists at ' +
        '/var/run/docker.sock, /run/podman/podman.sock, /run/user/1000/podman/podman.sock, and ' +
        'DOCKER_HOST is not set. Agent labels: linux, kici:agent:container. Run container ' +
        'jobs on an agent that reports kici:runtime:docker or kici:runtime:podman, or install ' +
        'Docker or Podman on this host.',
    );
  });

  it('names a DOCKER_HOST that points at nothing', () => {
    expect(
      missingRuntimeMessage({
        container: { dockerfile: '.kici/ci.Dockerfile' },
        agentLabels: [],
        deps: { ...noRuntime, env: { DOCKER_HOST: 'unix:///run/missing.sock' } },
      }),
    ).toContain(
      'in a container (an image built from .kici/ci.Dockerfile), but this agent has no ' +
        'container runtime to start it on: DOCKER_HOST is unix:///run/missing.sock, and no ' +
        'socket exists there. Agent labels: (none).',
    );
  });
});

describe('dockerClientFor', () => {
  it('binds the client to the resolved socket', () => {
    const client = dockerClientFor({
      fact: RuntimeFact.enum.podman,
      socketPath: '/run/user/1000/podman/podman.sock',
    });

    // fails-when: the client ignores the resolved socket and dials the Docker default
    expect((client.modem as { socketPath?: string }).socketPath).toBe(
      '/run/user/1000/podman/podman.sock',
    );
  });
});
