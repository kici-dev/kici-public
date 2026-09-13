import { describe, it, expect } from 'vitest';
import { registryHostFromImageRef } from './registry-auth.js';

describe('registryHostFromImageRef', () => {
  it.each([
    ['ghcr.io/acme/ci:1.2', 'ghcr.io'],
    ['reg.internal:5000/acme/ci:1.2', 'reg.internal:5000'],
    ['quay.io/kici-dev/kici-agent:0.5.0', 'quay.io'],
    ['acme/ci:1.2', 'docker.io'],
    ['nginx', 'docker.io'],
    ['library/nginx:1.27', 'docker.io'],
    ['localhost/foo:bar', 'localhost'],
    ['localhost:5000/foo', 'localhost:5000'],
  ])('%s → %s', (image, host) => {
    expect(registryHostFromImageRef(image)).toBe(host);
  });

  it('is not confused by a digest pin', () => {
    expect(registryHostFromImageRef('ghcr.io/acme/ci@sha256:' + 'a'.repeat(64))).toBe('ghcr.io');
    // No registry host, so the digest must not be mistaken for one.
    expect(registryHostFromImageRef('nginx@sha256:' + 'b'.repeat(64))).toBe('docker.io');
  });

  it('treats a multi-segment path under a host as that host', () => {
    expect(registryHostFromImageRef('reg.example.com/team/group/ci:1')).toBe('reg.example.com');
  });
});
