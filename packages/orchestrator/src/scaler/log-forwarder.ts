/**
 * Agent log forwarding: enriches agent log lines with metadata and writes them
 * to a stream (typically orchestrator stdout for ELK ingestion). A non-JSON
 * line, or JSON that is not an object, is wrapped as an info-level object.
 *
 * The `service` field identifies the originating tier for forwarded logs that flow
 * through orchestrator stdout (where `kici.service` from container name would say
 * `orchestrator`). This is NOT a rename of `app.source` -- it serves the different
 * purpose of identifying forwarded log origin for scaler-managed agents only.
 */

import type { LogCapture } from './types.js';

interface ForwardContext {
  runId?: string;
  requestId?: string;
  jobId?: string;
}

/**
 * Enrich and forward one log line; also used by the WS agent.log path (agent-handler).
 *
 * @param logsSource - e.g. 'docker', 'podman', 'bare-metal', 'firecracker-serial'
 */
export function forwardLine(
  line: string,
  agentId: string,
  output: NodeJS.WritableStream,
  context?: ForwardContext,
  logsSource?: string,
): void {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      parsed = { level: 'info', message: line };
    }
  } catch {
    parsed = { level: 'info', message: line };
  }

  parsed.service = 'agent';
  parsed.agentId = agentId;

  if (context?.runId) parsed.runId = context.runId;
  if (context?.requestId) parsed.requestId = context.requestId;
  if (context?.jobId) parsed.jobId = context.jobId;

  if (logsSource) parsed.logsSource = logsSource;

  output.write(JSON.stringify(parsed) + '\n');
}

/**
 * Used by scaler backends (container, bare-metal, Firecracker) to forward
 * agent stdout/stderr to orchestrator stdout for ELK ingestion.
 */
export class AgentLogForwarder {
  private readonly agentId: string;
  private readonly output: NodeJS.WritableStream;

  constructor(agentId: string, output: NodeJS.WritableStream = process.stdout) {
    this.agentId = agentId;
    this.output = output;
  }

  /** Resolves when the capture's async iterable ends. */
  async forward(capture: LogCapture, context?: ForwardContext, logsSource?: string): Promise<void> {
    for await (const line of capture.lines()) {
      forwardLine(line, this.agentId, this.output, context, logsSource);
    }
  }
}
