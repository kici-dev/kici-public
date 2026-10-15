/**
 * Heartbeat monitor for agent WebSocket connections:
 * - Logs (info level) agents past the unhealthy threshold (90s).
 * - Forcibly disconnects agents past the disconnect threshold (180s).
 *
 * Mirrors the Platform's heartbeat monitor.
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
 * An agent silent for 90s is unhealthy (log only). One silent for 180s gets
 * dispatcher.onAgentDisconnect, then is unregistered and its socket closed.
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

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private check(): void {
    const now = Date.now();

    for (const entry of [...this.registry.getAllEntries()]) {
      const elapsed = now - entry.lastHeartbeatAt;

      if (elapsed > this.disconnectThresholdMs) {
        logger.warn('Closing stale agent connection', {
          agentId: entry.agentId,
          elapsedMs: elapsed,
        });

        // Ordering: the dispatcher reads the registration before its first await, so
        // triage starts first. Unregistering right after means the socket's close finds
        // no registration: it tears the agent down as dropped (`heartbeat-timeout` for an
        // event scaler) and does not triage its jobs a second time.
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
        logger.info('Agent connection unhealthy', {
          agentId: entry.agentId,
          elapsedMs: elapsed,
        });
      }
    }
  }
}
