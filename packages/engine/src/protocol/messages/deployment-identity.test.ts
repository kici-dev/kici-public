import { describe, it, expect } from 'vitest';
import { DeploymentModeSchema, DeploymentIdentitySchema } from './deployment-identity.js';

describe('DeploymentIdentitySchema', () => {
  it('accepts a compose identity with container fields', () => {
    const parsed = DeploymentIdentitySchema.parse({
      mode: 'compose',
      containerName: 'kici-orchestrator',
      containerRuntime: 'podman',
    });
    expect(parsed.mode).toBe('compose');
    expect(parsed.containerName).toBe('kici-orchestrator');
    expect(parsed.containerRuntime).toBe('podman');
  });

  it('accepts a bare-metal identity with no container fields', () => {
    const parsed = DeploymentIdentitySchema.parse({ mode: 'systemd' });
    expect(parsed.mode).toBe('systemd');
    expect(parsed.containerName).toBeUndefined();
  });

  it('accepts the unknown mode', () => {
    expect(DeploymentIdentitySchema.parse({ mode: 'unknown' }).mode).toBe('unknown');
  });

  it('rejects an invalid mode', () => {
    expect(() => DeploymentModeSchema.parse('kubernetes')).toThrow();
  });

  it('rejects an invalid container runtime', () => {
    expect(() =>
      DeploymentIdentitySchema.parse({ mode: 'compose', containerRuntime: 'containerd' }),
    ).toThrow();
  });
});
