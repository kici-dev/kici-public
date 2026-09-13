/**
 * Heartbeat monitor for agent WebSocket connections.
 *
 * Periodically inspects all registered agents and:
 * - Logs warnings for agents past the unhealthy threshold (90s).
 * - Forcibly disconnects agents past the disconnect threshold (180s).
 *
 * Follows the same pattern as the Platform HeartbeatMonitor
 * (packages/platform/src/ws/heartbeat.ts) for consistency across
 * the three-tier architecture.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import { WS_CLOSE_HEARTBEAT_TIMEOUT } from '@kici-dev/engine';
import { setAgentsActive } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'agent-heartbeat' });

interface AgentHeartbeatMonitorDeps {
  registry: AgentRegistry;
  dispatcher: Dispatcher;
  /** Silence duration after which an agent is considered unhealthy (default 90s). */
  unhealthyThresholdMs?: number;
  /** Silence duration after which an agent is forcibly disconnected (default 180s). */
  disconnectThresholdMs?: number;
  /** How often to run the heartbeat check (default 30s). */
  checkIntervalMs?: number;
}

/**
 * Periodically inspects all registered agent connections and:
 * - Marks agents as unhealthy after 90s of silence (log only).
 * - Closes and unregisters agents after 180s of silence.
 * - Triggers dispatcher.onAgentDisconnect for stale agents.
 */
export class AgentHeartbeatMonitor {
  private readonly registry: AgentRegistry;
  private readonly dispatcher: Dispatcher;
  private readonly unhealthyThresholdMs: number;
  private readonly disconnectThresholdMs: number;
  private readonly checkIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AgentHeartbeatMonitorDeps) {
    this.registry = deps.registry;
    this.dispatcher = deps.dispatcher;
    this.unhealthyThresholdMs = deps.unhealthyThresholdMs ?? 90_000;
    this.disconnectThresholdMs = deps.disconnectThresholdMs ?? 180_000;
    this.checkIntervalMs = deps.checkIntervalMs ?? 30_000;
  }

  /** Start the periodic heartbeat check. */
  start(): void {
    if (this.interval) return; // already running
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop the periodic heartbeat check. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────

  private check(): void {
    const now = Date.now();

    for (const entry of this.registry.getAllEntries()) {
      const elapsed = now - entry.lastHeartbeatAt;

      if (elapsed > this.disconnectThresholdMs) {
        // Agent is stale -- close and unregister
        logger.warn('Closing stale agent connection', {
          agentId: entry.agentId,
          elapsedMs: elapsed,
        });

        entry.ws.close(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');

        // Dispatcher handles: mark dispatched jobs as failed, unregister from registry
        this.dispatcher.onAgentDisconnect(entry.agentId).catch((err) => {
          logger.error('Error handling stale agent disconnect', {
            agentId: entry.agentId,
            error: toErrorMessage(err),
          });
        });

        setAgentsActive(Math.max(0, this.registry.getActiveCount() - 1));
      } else if (elapsed > this.unhealthyThresholdMs) {
        // Agent is unhealthy but not stale yet -- log only
        logger.info('Agent connection unhealthy', {
          agentId: entry.agentId,
          elapsedMs: elapsed,
        });
      }
    }
  }
}
