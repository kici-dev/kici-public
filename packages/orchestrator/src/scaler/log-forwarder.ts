/**
 * Agent log forwarding: enriches agent log lines with metadata and writes
 * them to a writable stream (typically orchestrator stdout for ELK ingestion).
 *
 * Handles both JSON and non-JSON log lines:
 * - JSON lines are parsed, enriched with agent/context metadata, and re-serialized.
 * - Non-JSON lines are wrapped as info-level JSON objects.
 *
 * The `service` field identifies the originating tier for forwarded logs that flow
 * through orchestrator stdout (where `kici.service` from container name would say
 * `orchestrator`). This is NOT a rename of `app.source` -- it serves the different
 * purpose of identifying forwarded log origin for scaler-managed agents only.
 */

import type { LogCapture } from './types.js';

/** Context fields merged into each forwarded log line. */
interface ForwardContext {
  runId?: string;
  requestId?: string;
  jobId?: string;
}

/**
 * Enrich and forward a single log line to an output stream.
 *
 * Standalone function for use in the WS agent.log path (agent-handler).
 *
 * @param line - Raw log line from the agent
 * @param agentId - The agent that produced the line
 * @param output - Writable stream to write enriched JSON to
 * @param context - Optional trace context fields
 * @param logsSource - Optional log source identifier (e.g. 'docker', 'podman', 'bare-metal', 'firecracker-serial')
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
      // Parsed but not an object -- wrap it
      parsed = { level: 'info', message: line };
    }
  } catch {
    // Not valid JSON -- wrap as info-level message
    parsed = { level: 'info', message: line };
  }

  // Enrich with agent metadata
  parsed.service = 'agent';
  parsed.agentId = agentId;

  // Merge trace context if present
  if (context?.runId) parsed.runId = context.runId;
  if (context?.requestId) parsed.requestId = context.requestId;
  if (context?.jobId) parsed.jobId = context.jobId;

  // Tag with log capture source identifier
  if (logsSource) parsed.logsSource = logsSource;

  output.write(JSON.stringify(parsed) + '\n');
}

/**
 * Consumes a LogCapture stream and forwards enriched log lines to an output stream.
 *
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

  /**
   * Forward all lines from a LogCapture to the output stream.
   * Resolves when the capture's async iterable ends.
   *
   * @param capture - LogCapture to consume
   * @param context - Optional trace context fields
   * @param logsSource - Optional log source identifier (e.g. 'docker', 'podman', 'bare-metal')
   */
  async forward(capture: LogCapture, context?: ForwardContext, logsSource?: string): Promise<void> {
    for await (const line of capture.lines()) {
      forwardLine(line, this.agentId, this.output, context, logsSource);
    }
  }
}
