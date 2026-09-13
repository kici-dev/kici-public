import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '@kici-dev/engine';
import { createCapabilitiesRoutes } from './capabilities.js';

describe('GET /api/v1/capabilities', () => {
  it('returns the current capability manifest', async () => {
    const app = createCapabilitiesRoutes();
    const res = await app.request('/api/v1/capabilities');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orchestratorVersion: string;
      protocolVersion: number;
      minProtocolVersion: number;
    };

    // KICI_PKG_VERSION is only injected by the service-build bundler, so in
    // unit tests the route falls back to 'unknown'. Assert shape, not value.
    expect(typeof body.orchestratorVersion).toBe('string');
    expect(body.orchestratorVersion.length).toBeGreaterThan(0);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.minProtocolVersion).toBe(MIN_PROTOCOL_VERSION);
  });

  it('is publicly reachable (no auth required)', async () => {
    // Health + capabilities share the no-auth posture: both expose version
    // info and must be reachable before the client has a session.
    const app = createCapabilitiesRoutes();
    const res = await app.request('/api/v1/capabilities');
    expect(res.status).toBe(200);
  });
});
