import { Hono } from 'hono';

/** The `status` a `/health` liveness probe returns. It is `ok` whenever the process answers. */
enum LivenessStatus {
  Ok = 'ok',
}

/** The `status` values a `/ready` readiness probe returns. */
export enum ReadinessStatus {
  Ready = 'ready',
  NotReady = 'not ready',
}

/**
 * The fields every `/health` body carries, before the service's own fields.
 * `status` is a plain string because a reader may talk to a service of
 * another version; this version always sends `ok`.
 */
export interface LivenessBase {
  status: string;
  /** ISO-8601 time the response was built. */
  timestamp: string;
  /** Process uptime in seconds, with a fractional part. */
  uptime: number;
}

/** A `/health` body: the base fields plus the service's `livenessInfo()` fields. */
export type LivenessResponse<T extends object> = LivenessBase & T;

/**
 * A `/ready` body. The route answers 503 with this same body when a check
 * fails, so a caller reads the body whatever the status code. `status` is a
 * plain string for the same reason as {@link LivenessBase}; compare it with
 * {@link ReadinessStatus}.
 */
export interface ReadinessResponse {
  status: string;
  /** One entry per readiness check, `true` when it passed. */
  checks: Record<string, boolean>;
}

/**
 * The build fingerprint a KiCI service reports on `/health`. Comparing the
 * bundle hashes of two services shows whether they were built from the same
 * SDK, shared and engine code.
 */
export interface BuildFingerprint {
  /** The KiCI release the service was built from, for example `0.12.0`. */
  version: string;
  sdkVersion: string;
  sdkBundleHash: string;
  sharedVersion: string;
  sharedBundleHash: string;
  engineVersion: string;
  engineBundleHash: string;
}

/**
 * The fields the agent adds to its `/health` body. The agent's health route
 * returns this type, and `kici-admin agent status` renders it.
 */
export interface AgentLivenessInfo extends BuildFingerprint {
  agentId: string;
  /** Whether the agent's WebSocket to its orchestrator is open. */
  connected: boolean;
  activeJobs: number;
}

export interface HealthRoutesDeps<T extends object = Record<string, unknown>> {
  /**
   * Optional extra fields to include in the liveness response.
   * Called on every `/health` request.
   */
  livenessInfo?: () => T;

  /**
   * Optional readiness checks. Each key is a check name, each value
   * indicates whether that check passed.
   * Called on every `/ready` request.
   * If omitted, the service is always considered ready.
   */
  readinessCheck?: () => Promise<Record<string, boolean>>;
}

/**
 * Create health and readiness routes.
 *
 * - GET /health - Liveness probe (always 200)
 * - GET /ready  - Readiness probe (200 if all checks pass, 503 if any fail)
 *
 * @param deps - Optional liveness info provider and readiness check function
 * @returns Hono app with /health and /ready endpoints
 */
export function createHealthRoutes<T extends object = Record<string, unknown>>(
  deps: HealthRoutesDeps<T> = {},
): Hono {
  const app = new Hono();

  /**
   * Liveness probe - always returns 200.
   * Includes timestamp, uptime, and any extra info from livenessInfo().
   */
  app.get('/health', (c) => {
    const base: LivenessBase = {
      status: LivenessStatus.Ok,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
    return c.json({ ...base, ...deps.livenessInfo?.() });
  });

  /**
   * Readiness probe - returns 200 when all checks pass, 503 otherwise.
   * If no readiness check is provided, always returns 200.
   */
  app.get('/ready', async (c) => {
    const checks = deps.readinessCheck ? await deps.readinessCheck() : {};
    const ready = Object.values(checks).every((v) => v);
    const body: ReadinessResponse = {
      status: ready ? ReadinessStatus.Ready : ReadinessStatus.NotReady,
      checks,
    };

    return c.json(body, ready ? 200 : 503);
  });

  return app;
}
