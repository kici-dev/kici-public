import { LogStream } from '@kici-dev/engine';

/**
 * Shared factory for the zx `log` callback that streams a subprocess's
 * stdout/stderr into the captured/streamed run log, line by line, via `emit`.
 *
 * zx does NOT write child stdout/stderr to `process.stdout`; it pipes the
 * child stdio to an internal VoidStream and surfaces each chunk through the
 * shell's `log` callback as `{ kind: 'stdout' | 'stderr', data, verbose }`.
 * The `verbose` flag is zx's per-invocation quiet/verbose decision:
 *
 *   - stdout entries: `verbose = !piped && (snapshot.verbose && !snapshot.quiet)`
 *   - stderr entries: `verbose = !snapshot.quiet`
 *
 * so a step that opts into `$({ quiet: true })` (e.g. a `sops -d` decrypt of a
 * credential) produces `verbose: false` entries. This factory HONORS that flag
 * — it skips `verbose: false` entries — which is what makes `{ quiet: true }`
 * actually suppress sensitive output from the run log. Without the gate, a
 * decrypted-secret line leaks into the persisted/streamed log (zx's own default
 * log function gates on the same flag: `if (!entry.verbose) return`).
 *
 * IMPORTANT: the shell that installs this callback MUST be constructed with
 * `verbose: true`. With `verbose: true` zx flags ordinary (non-quiet)
 * subprocess output `verbose: true` (captured) and a `{ quiet: true }` call
 * `verbose: false` (suppressed). A `verbose: false` base would flag ordinary
 * output `verbose: false` too, and this gate would then drop every line.
 *
 * The returned callback owns one line buffer PER STREAM, so partial chunks are
 * coalesced into whole lines before `emit` is called. The buffers are separate
 * because the two streams are independent pipes: a stdout chunk ending mid-line
 * and a stderr chunk arriving next would otherwise concatenate into a single
 * spliced line attributed to whichever kind completed it.
 *
 * `emit` receives the originating stream alongside the line so a diagnostic
 * written to stderr stays distinguishable from ordinary progress output all the
 * way to the persisted run log.
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
    // Honor the per-invocation quiet/verbose intent. `$({ quiet: true })` (or an
    // explicit `{ verbose: false }`) marks the entry `verbose: false` — the
    // signal to keep this line out of the captured run log.
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
