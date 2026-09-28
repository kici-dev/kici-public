/**
 * How long an init system waits for a KiCI service to shut down.
 */

import type { ServiceConfig } from './types.js';

/**
 * Seconds an init system must wait after SIGTERM before it SIGKILLs the service.
 *
 * The runtime defaults are shorter than either component's own graceful-shutdown
 * budget: Compose waits 10s, launchd's default ExitTimeOut is 5s, and shawl's
 * default `--stop-timeout` on Windows is 3s. A teardown that
 * takes longer is killed partway through: the orchestrator never broadcasts
 * `peer.leaving` and never closes its agent sockets, and the agent never
 * finishes draining. That window is reached exactly when it matters most — the
 * orchestrator's scaler stops each managed agent with its own grace, so an
 * orchestrator with agents in flight routinely needs more than 10s.
 *
 * Each value is its component's force-exit budget plus headroom, so the
 * process always reaches its own timer first and the runtime's kill stays the
 * last resort it is meant to be:
 * - orchestrator: 30s (`setupGracefulShutdown` default) plus up to 2s of log
 *   file flush -> 45s
 * - agent: 10s plus a ~1s abort delay in its `onForceExit` -> 20s
 *
 * An unrecognised component gets the larger value: over-waiting costs a few
 * seconds on shutdown, under-waiting corrupts it.
 */
export function shutdownGraceSeconds(config: ServiceConfig): number {
  const component = config.component ?? (config.name === 'kici-agent' ? 'agent' : 'orchestrator');
  return component === 'agent' ? 20 : 45;
}

/**
 * Seconds a `stop` waits for the init system to report the service stopped.
 *
 * The init system kills the process once its grace elapses, so a service still
 * running after the grace plus this margin is hung, not slow.
 */
export function stopWaitSeconds(config: ServiceConfig): number {
  return shutdownGraceSeconds(config) + 15;
}
