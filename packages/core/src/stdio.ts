/**
 * Make a CLI's stdout and stderr blocking, so `process.exit()` cannot drop
 * output that is still queued.
 *
 * On Linux, Node writes to a pipe asynchronously. Every KiCI CLI ends a command
 * with `process.exit()`, which exits before the queued writes reach the pipe:
 * `kici runs list --json | slow-reader` received 8192 of 9156 bytes. A blocking
 * handle finishes each write before the call returns, so the exit drops nothing.
 * Files and terminals are already synchronous; the call is a no-op for them.
 *
 * Call it once, at the start of a CLI entry point, before anything is written.
 */
export function makeCliStdioBlocking(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const handle = (stream as { _handle?: { setBlocking?: (blocking: boolean) => unknown } })
      ._handle;
    handle?.setBlocking?.(true);
  }
}
