/**
 * Convert a worker-relayed `peer.log.chunk` into log-sink chunks. The peer frame carries a
 * timestamp and stream per line; the sink (and `LogWriter.appendChunk`) takes one per chunk.
 * Grouping consecutive lines that agree on both is lossless and keeps line order. A worker
 * gives a chunk's lines one timestamp and stream, so this yields one group in practice.
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
      stream: line.stream,
    });
  }

  return groups;
}
