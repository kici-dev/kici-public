import { describe, it, expect } from 'vitest';
import { RuntimeFact } from '@kici-dev/engine';
import { detectRuntimeFacts, resolveContainerRuntime, runtimeFactLabels } from './runtime-facts.js';

// No DOCKER_HOST, so no case depends on the environment the test runs in.
const none = { pathExists: () => false, binaryOnPath: () => false, env: {}, uid: 1000 };
const existing =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('detectRuntimeFacts', () => {
  it('reports nothing on a host with neither a socket nor a CLI', () => {
    expect(detectRuntimeFacts(none)).toEqual([]);
  });

  it('reports docker when its socket is there', () => {
    expect(detectRuntimeFacts({ ...none, pathExists: existing('/var/run/docker.sock') })).toEqual([
      RuntimeFact.enum.docker,
    ]);
  });

  it('reports podman for the rootful socket', () => {
    expect(
      detectRuntimeFacts({ ...none, pathExists: existing('/run/podman/podman.sock') }),
    ).toEqual([RuntimeFact.enum.podman]);
  });

  it('reports podman for the rootless socket of the agent user', () => {
    expect(
      detectRuntimeFacts({ ...none, pathExists: existing('/run/user/1000/podman/podman.sock') }),
    ).toEqual([RuntimeFact.enum.podman]);
  });

  it('separates being able to RUN a container from being able to BUILD one', () => {
    // A containerized agent handed only a mounted socket can nest a job
    // container and cannot build one — the build shells out to the CLI. Two
    // facts, because a host can genuinely have one and not the other.
    const socketOnly = detectRuntimeFacts({
      ...none,
      pathExists: existing('/var/run/docker.sock'),
    });
    expect(socketOnly).toEqual([RuntimeFact.enum.docker]);
    expect(socketOnly).not.toContain(RuntimeFact.enum['container-build']);

    const cliOnly = detectRuntimeFacts({ ...none, binaryOnPath: () => true });
    expect(cliOnly).toEqual([RuntimeFact.enum['container-build']]);
  });

  it('reports build capability from either CLI', () => {
    for (const bin of ['docker', 'podman']) {
      expect(detectRuntimeFacts({ ...none, binaryOnPath: (b) => b === bin })).toContain(
        RuntimeFact.enum['container-build'],
      );
    }
  });

  it('never repeats a fact when several sockets match', () => {
    const facts = detectRuntimeFacts({ ...none, pathExists: () => true });
    expect(new Set(facts).size).toBe(facts.length);
  });

  it('reports docker for a DOCKER_HOST that names a remote daemon', () => {
    // fails-when: an agent reaching Docker over tcp reports no runtime, and
    // the scaler keeps container jobs away from an agent that can run them
    expect(detectRuntimeFacts({ ...none, env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' } })).toEqual([
      RuntimeFact.enum.docker,
    ]);
  });

  it('reports no runtime for a DOCKER_HOST socket that is missing, whatever else exists', () => {
    // The sandbox does not fall back from DOCKER_HOST, so a label here would
    // route container jobs to an agent that cannot start them.
    expect(
      detectRuntimeFacts({
        ...none,
        env: { DOCKER_HOST: 'unix:///run/missing.sock' },
        pathExists: existing('/var/run/docker.sock'),
      }),
    ).toEqual([]);
  });
});

describe('the job-image fact', () => {
  it('is reported by an agent the scaler started inside a job image', () => {
    // fails-when: an agent started in a job's image registers like any other,
    // and an orchestrator that lost its spawn record hands it unrelated jobs
    expect(runtimeFactLabels({ ...none, env: { KICI_JOB_IMAGE_AGENT: '1' } })).toEqual([
      'kici:runtime:job-image',
    ]);
  });

  it('is not reported by any other agent', () => {
    // breaks-if-wrong: an ordinary agent must never restrict itself
    expect(runtimeFactLabels({ ...none, env: { KICI_JOB_IMAGE_AGENT: '0' } })).toEqual([]);
    expect(runtimeFactLabels(none)).toEqual([]);
  });
});

describe('resolveContainerRuntime', () => {
  it('returns null on a host with no socket and no DOCKER_HOST', () => {
    expect(resolveContainerRuntime(none)).toBeNull();
  });

  it('prefers the Docker socket, then Podman', () => {
    expect(resolveContainerRuntime({ ...none, pathExists: () => true })).toEqual({
      fact: RuntimeFact.enum.docker,
      socketPath: '/var/run/docker.sock',
    });
  });

  it('finds a host that runs only rootless Podman', () => {
    // fails-when: the client falls back to /var/run/docker.sock on a host
    // that has only Podman, and the job dies on `connect ENOENT`
    expect(
      resolveContainerRuntime({
        ...none,
        pathExists: existing('/run/user/1000/podman/podman.sock'),
      }),
    ).toEqual({ fact: RuntimeFact.enum.podman, socketPath: '/run/user/1000/podman/podman.sock' });
  });

  it('treats a set DOCKER_HOST socket as authoritative', () => {
    expect(
      resolveContainerRuntime({
        ...none,
        env: { DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
        pathExists: existing('/run/user/1000/podman/podman.sock', '/var/run/docker.sock'),
      }),
    ).toEqual({ fact: RuntimeFact.enum.docker, socketPath: '/run/user/1000/podman/podman.sock' });
    // breaks-if-wrong: a missing DOCKER_HOST socket is never swapped for a
    // different daemon the operator did not name
    expect(
      resolveContainerRuntime({
        ...none,
        env: { DOCKER_HOST: 'unix:///run/missing.sock' },
        pathExists: existing('/var/run/docker.sock'),
      }),
    ).toBeNull();
  });

  it('passes a remote DOCKER_HOST through as a host', () => {
    expect(
      resolveContainerRuntime({ ...none, env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' } }),
    ).toEqual({ fact: RuntimeFact.enum.docker, host: 'tcp://10.0.0.5:2375' });
  });
});

describe('runtimeFactLabels', () => {
  it('renders facts under the self-reported kici:runtime: prefix', () => {
    // The prefix matters: kici:runtime:* is a host FACT the register-time gate
    // accepts unchallenged. kici:capability:* grants a privilege and must stay
    // token-bound, so a fact must never be reported under it.
    const labels = runtimeFactLabels({ ...none, pathExists: () => true, binaryOnPath: () => true });
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.startsWith('kici:runtime:')).toBe(true);
      expect(l.startsWith('kici:capability:')).toBe(false);
    }
    expect(labels).toContain('kici:runtime:container-build');
  });

  it('renders nothing on a host with neither', () => {
    expect(runtimeFactLabels(none)).toEqual([]);
  });
});
