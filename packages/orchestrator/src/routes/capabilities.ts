/**
 * `/capabilities`: a versioned manifest the CLI reads to format actionable
 * errors on a feature gap (e.g. `kici status --logs` against an orchestrator
 * without the logs endpoint). See `docs/architecture/coordinator-worker.md`
 * for the minimum-version semantics this mirrors for the WS connections.
 *
 * Public (no auth), like `/health`, which already exposes the version: the CLI
 * must reach it even when authenticated calls fail with 404/401.
 */

import { Hono } from 'hono';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '@kici-dev/engine';

declare const KICI_PKG_VERSION: string;

export interface CapabilitiesManifest {
  /** Injected at build time. */
  orchestratorVersion: string;
  protocolVersion: number;
  /** Minimum protocol version accepted from peers/clients. */
  minProtocolVersion: number;
}

export function createCapabilitiesRoutes(): Hono {
  const app = new Hono();

  app.get('/api/v1/capabilities', (c) => {
    const manifest: CapabilitiesManifest = {
      orchestratorVersion: typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown',
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
    };
    return c.json(manifest);
  });

  return app;
}
