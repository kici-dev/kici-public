import { describe, it, expect } from 'vitest';
import {
  buildArgv,
  buildJobImage,
  makeLineSplitter,
  resolveBuildCli,
  ContainerBuildCli,
} from './build-engine.js';
import type { JobImageBuildSpec } from './resolve-build-spec.js';

const spec: JobImageBuildSpec = {
  dockerfilePath: '/work/job/.kici/ci.Dockerfile',
  contextDir: '/work/job',
  target: 'ci',
  args: { A: '1', B: '2' },
  tag: 'kici-build:run-1-build',
  labels: { 'kici-managed': 'true', 'kici-job-id': 'job-1' },
};

describe('resolveBuildCli', () => {
  it('honours an explicit operator choice even when the other is present', () => {
    expect(resolveBuildCli({ configured: ContainerBuildCli.enum.podman, onPath: () => true })).toBe(
      'podman',
    );
  });

  it('prefers docker when both are on PATH', () => {
    expect(resolveBuildCli({ onPath: () => true })).toBe('docker');
  });

  it('falls back to podman when docker is absent', () => {
    expect(resolveBuildCli({ onPath: (b) => b === 'podman' })).toBe('podman');
  });

  it('names both binaries when neither is installed', () => {
    // The CLI is required — there is no socket fallback — so the failure has to
    // say what to install rather than surfacing a bare ENOENT mid-job.
    expect(() => resolveBuildCli({ onPath: () => false })).toThrow(/docker.*podman/s);
  });

  it('refuses a configured CLI that is not installed, naming the knob', () => {
    expect(() =>
      resolveBuildCli({ configured: ContainerBuildCli.enum.docker, onPath: () => false }),
    ).toThrow(/KICI_CONTAINER_BUILD_CLI/);
  });
});

describe('buildArgv', () => {
  it('threads the sandbox socket so the build and the run hit the same daemon', () => {
    // A host with both runtimes would otherwise build on one daemon and start
    // the job container on another, surfacing as "no such image".
    expect(
      buildArgv({ cli: ContainerBuildCli.enum.docker, spec, socketPath: '/run/d.sock' }).slice(
        0,
        3,
      ),
    ).toEqual(['-H', 'unix:///run/d.sock', 'build']);
    expect(
      buildArgv({ cli: ContainerBuildCli.enum.podman, spec, socketPath: '/run/p.sock' }).slice(
        0,
        3,
      ),
    ).toEqual(['--url', 'unix:///run/p.sock', 'build']);
  });

  it('passes a socket that already carries a scheme through unchanged', () => {
    expect(
      buildArgv({
        cli: ContainerBuildCli.enum.docker,
        spec,
        socketPath: 'tcp://10.0.0.5:2375',
      }).slice(0, 2),
    ).toEqual(['-H', 'tcp://10.0.0.5:2375']);
  });

  it('omits the socket flag when there is none to thread', () => {
    expect(buildArgv({ cli: ContainerBuildCli.enum.docker, spec })[0]).toBe('build');
  });

  it('carries the dockerfile, target, args, labels and tag', () => {
    const argv = buildArgv({ cli: ContainerBuildCli.enum.docker, spec });
    expect(argv).toContain('-f');
    expect(argv).toContain('/work/job/.kici/ci.Dockerfile');
    expect(argv).toContain('--target');
    expect(argv).toContain('ci');
    expect(argv).toContain('--build-arg');
    expect(argv).toContain('A=1');
    expect(argv).toContain('B=2');
    expect(argv).toContain('--label');
    expect(argv).toContain('kici-managed=true');
    expect(argv).toContain('kici-job-id=job-1');
    expect(argv).toContain('-t');
    expect(argv).toContain('kici-build:run-1-build');
  });

  it('puts the context last, where both CLIs expect it', () => {
    const argv = buildArgv({ cli: ContainerBuildCli.enum.podman, spec, socketPath: '/run/p.sock' });
    expect(argv[argv.length - 1]).toBe('/work/job');
  });

  it('omits --target when the job named no stage', () => {
    const { target: _ignored, ...noTarget } = spec;
    const argv = buildArgv({ cli: ContainerBuildCli.enum.docker, spec: noTarget });
    expect(argv).not.toContain('--target');
  });
});

describe('makeLineSplitter', () => {
  it('emits whole lines and carries the remainder', () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.write(Buffer.from('one\ntw'));
    expect(lines).toEqual(['one']);
    s.write(Buffer.from('o\nthree\n'));
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('flushes a final line that has no trailing newline', () => {
    // A builder's dying words are written just before exit and usually carry no
    // newline. Without the flush, the one line the author most needs is the one
    // that never reaches the run log.
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.write(Buffer.from('ERROR: failed to solve'));
    expect(lines).toEqual([]);
    s.flush();
    expect(lines).toEqual(['ERROR: failed to solve']);
  });

  it('flushes nothing when the stream ended cleanly', () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.write(Buffer.from('done\n'));
    s.flush();
    expect(lines).toEqual(['done']);
  });
});

describe('buildJobImage abort', () => {
  it('refuses before spawning when the signal is already aborted', async () => {
    // A job cancelled while it was still cloning would otherwise run its whole
    // build to completion: an already-aborted signal never fires the listener
    // the spawn installs.
    const ac = new AbortController();
    ac.abort(new Error('job cancelled'));
    await expect(
      buildJobImage({
        spec,
        cli: ContainerBuildCli.enum.docker,
        onLog: () => {},
        signal: ac.signal,
      }),
    ).rejects.toThrow(/job cancelled/);
  });
});
