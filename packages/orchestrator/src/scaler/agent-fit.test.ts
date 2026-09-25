import { describe, it, expect } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import {
  agentMayRefuse,
  canAgentRunJob,
  CONTAINER_RUNTIME_LABELS,
  hasContainerRuntime,
  JobContainerNeed,
  jobContainerNeed,
  MIN_RUNTIME_FACTS_AGENT_VERSION,
  reportsRuntimeFacts,
  spawnsInJobImage,
  type FitAgent,
} from './agent-fit.js';

describe('jobContainerNeed', () => {
  it('reads no container as no need', () => {
    for (const container of [undefined, null, '', false]) {
      expect(jobContainerNeed(container)).toBe(JobContainerNeed.None);
    }
  });

  it('reads the string shorthand and an image object as an image', () => {
    expect(jobContainerNeed('python:3.12')).toBe(JobContainerNeed.Image);
    expect(jobContainerNeed({ image: 'python:3.12' })).toBe(JobContainerNeed.Image);
  });

  it('reads a dockerfile as a build', () => {
    expect(jobContainerNeed({ dockerfile: '.kici/ci.Dockerfile' })).toBe(
      JobContainerNeed.Dockerfile,
    );
  });

  it('reads any other set declaration as a container job, as the agent does', () => {
    // fails-when: a declaration the agent runs in container mode is routed as
    // a plain job, onto an agent that cannot start the container
    expect(jobContainerNeed({ env: { A: '1' } })).toBe(JobContainerNeed.Image);
  });
});

describe('hasContainerRuntime', () => {
  it('accepts the docker and podman runtime facts', () => {
    expect(CONTAINER_RUNTIME_LABELS).toEqual(['kici:runtime:docker', 'kici:runtime:podman']);
    expect(hasContainerRuntime(['linux', 'kici:runtime:docker'])).toBe(true);
    expect(hasContainerRuntime(new Set(['kici:runtime:podman']))).toBe(true);
  });

  it('does not take a build CLI, or nothing, as a runtime', () => {
    // fails-when: an agent with only a build CLI is admitted to run a container
    expect(hasContainerRuntime(['linux', 'kici:runtime:container-build'])).toBe(false);
    expect(hasContainerRuntime([])).toBe(false);
  });
});

describe('spawnsInJobImage', () => {
  it('holds for every container-backend spawn', () => {
    expect(spawnsInJobImage(ScalerBackendType.enum.container, { image: 'agent:1' })).toBe(true);
  });

  it('holds for a bare-metal label set with an image and no binary only', () => {
    expect(spawnsInJobImage(ScalerBackendType.enum['bare-metal'], { image: 'agent:1' })).toBe(true);
    // breaks-if-wrong: a binary label set keeps nesting the job's container
    expect(
      spawnsInJobImage(ScalerBackendType.enum['bare-metal'], {
        image: 'agent:1',
        binaryPath: '/usr/local/bin/kici-agent',
      }),
    ).toBe(false);
    expect(
      spawnsInJobImage(ScalerBackendType.enum['bare-metal'], {
        binaryPath: '/usr/local/bin/kici-agent',
      }),
    ).toBe(false);
  });

  it('never holds for a backend that starts ordinary agents', () => {
    for (const type of [ScalerBackendType.enum.firecracker, ScalerBackendType.enum.event]) {
      expect(spawnsInJobImage(type, { image: 'agent:1' })).toBe(false);
    }
  });
});

/** An operator's own agent: no scaler record, registered with `labels`. */
const operatorAgent = (labels: string[], version: string | null): FitAgent => ({
  labels: new Set(labels),
  version,
  scalerManaged: false,
});
const containerJob = { jobId: 'job-c', container: JobContainerNeed.Image };
const plainJob = { jobId: 'job-p', container: JobContainerNeed.None };

describe('reportsRuntimeFacts', () => {
  it('holds from the first release whose runtime labels match the socket it uses', () => {
    expect(MIN_RUNTIME_FACTS_AGENT_VERSION).toBe('0.10.0');
    expect(reportsRuntimeFacts({ labels: [], version: '0.10.0' })).toBe(true);
    // A dev build carries a build-counter suffix on the same release base.
    expect(reportsRuntimeFacts({ labels: [], version: '0.10.0-9904' })).toBe(true);
  });

  it('does not hold for an earlier or unversioned agent', () => {
    for (const version of ['0.9.1', '0.6.0', '0.5.0', null]) {
      expect(reportsRuntimeFacts({ labels: ['linux'], version })).toBe(false);
    }
  });

  it('holds for an agent reporting the job-image fact, which only such a release sends', () => {
    expect(reportsRuntimeFacts({ labels: ['kici:runtime:job-image'], version: null })).toBe(true);
  });

  it('does not hold for an earlier agent that reports a build CLI', () => {
    // A 0.9.x agent pointed at a remote DOCKER_HOST reports container-build
    // (its image ships the CLI) and no docker label, and runs container jobs.
    expect(
      reportsRuntimeFacts({ labels: ['kici:runtime:container-build'], version: '0.9.1' }),
    ).toBe(false);
  });
});

describe('canAgentRunJob on an operator agent', () => {
  it('refuses a container job to a 0.10.0 agent that reports no docker or podman runtime', () => {
    // fails-when: an agent whose labels prove it has no runtime takes a
    // container job, which then certainly fails
    const agent = operatorAgent(['linux', 'kici:runtime:container-build'], '0.10.0');
    expect(canAgentRunJob(agent, containerJob)).toBe(false);
    expect(agentMayRefuse(agent)).toBe(true);
    // breaks-if-wrong: the same agent keeps every plain job
    expect(canAgentRunJob(agent, plainJob)).toBe(true);
  });

  it('runs a container job on an agent that reports a runtime', () => {
    const agent = operatorAgent(['linux', 'kici:runtime:podman'], '0.10.0');
    expect(canAgentRunJob(agent, containerJob)).toBe(true);
    expect(agentMayRefuse(agent)).toBe(false);
  });

  it('still hands a container job to a 0.9.1 agent with no docker label', () => {
    // breaks-if-wrong: a released agent pointed at `tcp://` DOCKER_HOST reports
    // no docker label and runs container jobs through its client
    for (const labels of [['linux'], ['linux', 'kici:runtime:container-build']]) {
      const agent = operatorAgent(labels, '0.9.1');
      expect(canAgentRunJob(agent, containerJob)).toBe(true);
      expect(agentMayRefuse(agent)).toBe(false);
    }
  });

  it('leaves an unversioned agent ungated', () => {
    const agent = operatorAgent(['linux'], null);
    expect(canAgentRunJob(agent, containerJob)).toBe(true);
    expect(agentMayRefuse(agent)).toBe(false);
  });

  it('gives an agent that says it runs inside a job image no job, with no scaler record', () => {
    // fails-when: an image agent the scaler no longer tracks drains unrelated
    // work into the customer image it runs in
    const agent = operatorAgent(['linux', 'kici:runtime:job-image', 'kici:runtime:docker'], null);
    expect(canAgentRunJob(agent, plainJob)).toBe(false);
    expect(canAgentRunJob(agent, containerJob)).toBe(false);
    expect(agentMayRefuse(agent)).toBe(true);
  });

  it('lets an agent started in a job image run that job by the scaler record', () => {
    const agent: FitAgent = {
      ...operatorAgent(['linux', 'kici:runtime:job-image'], '0.10.0'),
      scaler: {
        binding: { jobId: 'job-c', jobImage: true },
        prespawned: false,
        shapeFits: () => true,
      },
    };
    // breaks-if-wrong: the self-reported fact must not refuse the agent its own job
    expect(canAgentRunJob(agent, containerJob)).toBe(true);
    expect(canAgentRunJob(agent, { ...plainJob, jobId: 'other' })).toBe(false);
  });
});
