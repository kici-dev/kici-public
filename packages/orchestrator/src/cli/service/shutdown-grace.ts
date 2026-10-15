import type { ServiceConfig } from './types.js';

/**
 * Seconds an init system must wait after SIGTERM before it SIGKILLs the service.
 *
 * Runtime defaults (Compose 10s, launchd ExitTimeOut 5s, shawl `--stop-timeout`
 * 3s) are shorter than either component's graceful shutdown, so the orchestrator
 * would never broadcast `peer.leaving` or close its agent sockets, and the agent
 * would never finish draining. An orchestrator stopping its scaler's agents, each
 * with its own grace, routinely needs more than 10s.
 *
 * Each value is the component's force-exit budget plus headroom, so its own
 * timer always fires before the runtime's kill:
 * - orchestrator: 30s (`setupGracefulShutdown` default) plus up to 2s of log
 *   file flush -> 45s
 * - agent: 10s plus a ~1s abort delay in its `onForceExit` -> 20s
 *
 * An unrecognised component gets the larger value: over-waiting costs seconds,
 * under-waiting corrupts the shutdown.
 */
export function shutdownGraceSeconds(config: ServiceConfig): number {
  const component = config.component ?? (config.name === 'kici-agent' ? 'agent' : 'orchestrator');
  return component === 'agent' ? 20 : 45;
}

/**
 * Seconds a `stop` waits for the service to report stopped. The init system
 * kills it once its grace elapses, so one still running after this is hung.
 */
export function stopWaitSeconds(config: ServiceConfig): number {
  return shutdownGraceSeconds(config) + 15;
}
