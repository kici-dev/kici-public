import { describe, it, expect } from 'vitest';
import { containerRuntimeForSocketPath } from './container-runtime.js';

describe('containerRuntimeForSocketPath', () => {
  it('reads Podman from rootless and rootful Podman socket paths', () => {
    expect(containerRuntimeForSocketPath('/run/user/1000/podman/podman.sock')).toBe('podman');
    expect(containerRuntimeForSocketPath('/run/podman/podman.sock')).toBe('podman');
  });

  it('reads Docker from any other socket path', () => {
    expect(containerRuntimeForSocketPath('/var/run/docker.sock')).toBe('docker');
    expect(containerRuntimeForSocketPath('/custom/runtime.sock')).toBe('docker');
  });
});
