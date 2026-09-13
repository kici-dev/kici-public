/**
 * Convert a worker-relayed `peer.log.chunk` into the chunk shape the log sink
 * consumes.
 *
 * The peer frame carries a timestamp and an originating stream per line, while
 * the sink (and `LogWriter.appendChunk` beneath it) takes one of each per
 * chunk. Grouping consecutive lines that agree on both is lossless and keeps
 * line order intact. A worker today gives every line in a chunk the same
 * timestamp and stream, so this yields a single group in practice.
 */
import type { PeerLogChunk } from '@kici-dev/engine';
import type { NormalizedLogChunk } from './log-chunk-sink.js';

export function normalizePeerLogChunk(chunk: PeerLogChunk): NormalizedLogChunk[] {
  const groups: NormalizedLogChunk[] = [];

  for (const line of chunk.lines) {
    const last = groups[groups.length - 1];
    if (last && last.timestamp === line.timestamp && last.stream === line.stream) {
      last.lines.push(line.text);
      continue;
    }

    groups.push({
      runId: chunk.runId,
      jobId: chunk.jobId,
      stepIndex: chunk.stepIndex,
      lines: [line.text],
      timestamp: line.timestamp,
      ...(line.stream !== undefined && { stream: line.stream }),
    });
  }

  return groups;
}
