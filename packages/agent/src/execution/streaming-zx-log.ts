import { LogStream } from '@kici-dev/engine';

/**
 * The zx `log` callback that streams a subprocess's stdout/stderr into the run
 * log, line by line, via `emit`.
 *
 * zx does not write child output to `process.stdout`; it surfaces each chunk
 * through the shell's `log` callback as `{ kind, data, verbose }`, where
 * `verbose` is zx's per-invocation decision:
 *
 *   - stdout entries: `verbose = !piped && (snapshot.verbose && !snapshot.quiet)`
 *   - stderr entries: `verbose = !snapshot.quiet`
 *
 * Skipping `verbose: false` entries is what makes `$({ quiet: true })` (e.g. a
 * `sops -d` decrypt) keep a secret out of the persisted log; zx's own default
 * log function gates the same way.
 *
 * IMPORTANT: the installing shell MUST be built with `verbose: true`; a
 * `verbose: false` base flags ordinary output `verbose: false` too, and every
 * line is dropped.
 *
 * Each stream gets its own line buffer: they are independent pipes, and a
 * shared buffer would splice a mid-line stdout chunk with the next stderr
 * chunk.
 */
export function makeStreamingZxLog(
  emit: (line: string, stream: LogStream) => void,
): (entry: unknown) => void {
  const lineBufs: Record<LogStream, string> = {
    [LogStream.enum.stdout]: '',
    [LogStream.enum.stderr]: '',
  };
  return (entry: unknown) => {
    const e = entry as { kind?: string; data?: unknown; verbose?: boolean };
    if (e.kind !== 'stdout' && e.kind !== 'stderr') return;
    // `$({ quiet: true })` or an explicit `{ verbose: false }`.
    if (!e.verbose) return;
    const stream = e.kind === 'stderr' ? LogStream.enum.stderr : LogStream.enum.stdout;
    const text = typeof e.data === 'string' ? e.data : String(e.data ?? '');
    const lines = (lineBufs[stream] + text).split('\n');
    lineBufs[stream] = lines.pop()!;
    for (const line of lines) {
      if (line) emit(line, stream);
    }
  };
}
