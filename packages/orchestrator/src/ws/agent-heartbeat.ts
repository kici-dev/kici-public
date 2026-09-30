/**
 * Heartbeat monitor for agent WebSocket connections.
 *
 * Periodically inspects all registered agents and:
 * - Logs warnings for agents past the unhealthy threshold (90s).
 * - Forcibly disconnects agents past the disconnect threshold (180s).
 *
 * Follows the same pattern as the Platform's heartbeat monitor, for
 * consistency across the three-tier architecture.
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
 * - Triggers dispatcher.onAgentDisconnect for an agent silent for 180s, then
 *   unregisters it and closes its socket.
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

    for (const entry of [...this.registry.getAllEntries()]) {
      const elapsed = now - entry.lastHeartbeatAt;

      if (elapsed > this.disconnectThresholdMs) {
        // Agent is stale -- triage its jobs, unregister, then close
        logger.warn('Closing stale agent connection', {
          agentId: entry.agentId,
          elapsedMs: elapsed,
        });

        // The dispatcher reads the registration before its first await, so the
        // triage starts first. The unregister right after removes the agent at
        // once, so the socket's close finds no registration: it tears the agent
        // down as dropped (`heartbeat-timeout` for an event scaler) and does
        // not triage its jobs a second time.
        this.dispatcher.onAgentDisconnect(entry.agentId).catch((err) => {
          logger.error('Error handling stale agent disconnect', {
            agentId: entry.agentId,
            error: toErrorMessage(err),
          });
        });
        this.registry.unregister(entry.agentId);

        entry.ws.close(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');

        setAgentsActive(this.registry.getActiveCount());
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
