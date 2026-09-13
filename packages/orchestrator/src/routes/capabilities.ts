/**
 * Orchestrator capability manifest exposed to REST clients (the CLI).
 *
 * The `/capabilities` endpoint returns a small versioned manifest the CLI can
 * read on demand to format actionable errors when it detects a feature gap
 * (e.g. `kici status --logs` against an orchestrator that lacks the logs
 * endpoint). See `docs/architecture/coordinator-worker.md` for the minimum-
 * version semantics this mirrors for the WS connections.
 *
 * Public (no auth) — same security posture as `/health`, which already exposes
 * the orchestrator's version. Version info must be reachable without a token
 * so the CLI can fetch it even when authenticated calls fail with 404/401.
 */

import { Hono } from 'hono';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '@kici-dev/engine';

declare const KICI_PKG_VERSION: string;

export interface CapabilitiesManifest {
  /** Orchestrator package version (injected at build time). */
  orchestratorVersion: string;
  /** Protocol version the orchestrator speaks. */
  protocolVersion: number;
  /** Minimum protocol version the orchestrator accepts from peers/clients. */
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
