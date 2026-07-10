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
 * The returned callback owns a per-shell line buffer, so partial chunks are
 * coalesced into whole lines before `emit` is called.
 */
export function makeStreamingZxLog(emit: (line: string) => void): (entry: unknown) => void {
  let lineBuf = '';
  return (entry: unknown) => {
    const e = entry as { kind?: string; data?: unknown; verbose?: boolean };
    if (e.kind !== 'stdout' && e.kind !== 'stderr') return;
    // Honor the per-invocation quiet/verbose intent. `$({ quiet: true })` (or an
    // explicit `{ verbose: false }`) marks the entry `verbose: false` — the
    // signal to keep this line out of the captured run log.
    if (!e.verbose) return;
    const text = typeof e.data === 'string' ? e.data : String(e.data ?? '');
    lineBuf += text;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop()!;
    for (const line of lines) {
      if (line) emit(line);
    }
  };
}
