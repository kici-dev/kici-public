import { describe, it, expect } from 'vitest';
import { readDeploymentIdentity } from './deployment-identity.js';

describe('readDeploymentIdentity', () => {
  it('reads a compose deployment with container name + runtime', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'compose',
      KICI_DEPLOY_CONTAINER: 'kici-orchestrator',
      KICI_DEPLOY_CONTAINER_RUNTIME: 'podman',
    });
    expect(id).toEqual({
      mode: 'compose',
      containerName: 'kici-orchestrator',
      containerRuntime: 'podman',
    });
  });

  it('reads a systemd deployment and drops container fields even if present', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'systemd',
      KICI_DEPLOY_CONTAINER: 'stray',
    });
    expect(id).toEqual({ mode: 'systemd' });
  });

  it('returns unknown when KICI_DEPLOY_MODE is unset', () => {
    expect(readDeploymentIdentity({})).toEqual({ mode: 'unknown' });
  });

  it('returns unknown for an unrecognised mode', () => {
    expect(readDeploymentIdentity({ KICI_DEPLOY_MODE: 'k8s' })).toEqual({ mode: 'unknown' });
  });

  it('defaults compose runtime to undefined when unset', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'compose',
      KICI_DEPLOY_CONTAINER: 'c1',
    });
    expect(id).toEqual({ mode: 'compose', containerName: 'c1' });
  });
});
