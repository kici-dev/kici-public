import { describe, it, expect } from 'vitest';
import { RuntimeFact } from '@kici-dev/engine';
import { detectRuntimeFacts, runtimeFactLabels } from './runtime-facts.js';

const none = { pathExists: () => false, binaryOnPath: () => false };

describe('detectRuntimeFacts', () => {
  it('reports nothing on a host with neither a socket nor a CLI', () => {
    expect(detectRuntimeFacts(none)).toEqual([]);
  });

  it('reports docker when its socket is there', () => {
    expect(
      detectRuntimeFacts({ ...none, pathExists: (p) => p === '/var/run/docker.sock' }),
    ).toEqual([RuntimeFact.enum.docker]);
  });

  it('reports podman for the rootful socket', () => {
    expect(
      detectRuntimeFacts({ ...none, pathExists: (p) => p === '/run/podman/podman.sock' }),
    ).toEqual([RuntimeFact.enum.podman]);
  });

  it('separates being able to RUN a container from being able to BUILD one', () => {
    // A containerized agent handed only a mounted socket can nest a job
    // container and cannot build one — the build shells out to the CLI. Two
    // facts, because a host can genuinely have one and not the other.
    const socketOnly = detectRuntimeFacts({
      pathExists: (p) => p === '/var/run/docker.sock',
      binaryOnPath: () => false,
    });
    expect(socketOnly).toEqual([RuntimeFact.enum.docker]);
    expect(socketOnly).not.toContain(RuntimeFact.enum['container-build']);

    const cliOnly = detectRuntimeFacts({ pathExists: () => false, binaryOnPath: () => true });
    expect(cliOnly).toEqual([RuntimeFact.enum['container-build']]);
  });

  it('reports build capability from either CLI', () => {
    for (const bin of ['docker', 'podman']) {
      expect(
        detectRuntimeFacts({ pathExists: () => false, binaryOnPath: (b) => b === bin }),
      ).toContain(RuntimeFact.enum['container-build']);
    }
  });

  it('never repeats a fact when several sockets match', () => {
    const facts = detectRuntimeFacts({ ...none, pathExists: () => true });
    expect(new Set(facts).size).toBe(facts.length);
  });
});

describe('runtimeFactLabels', () => {
  it('renders facts under the self-reported kici:runtime: prefix', () => {
    // The prefix matters: kici:runtime:* is a host FACT the register-time gate
    // accepts unchallenged. kici:capability:* grants a privilege and must stay
    // token-bound, so a fact must never be reported under it.
    const labels = runtimeFactLabels({ pathExists: () => true, binaryOnPath: () => true });
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
