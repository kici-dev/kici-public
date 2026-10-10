/**
 * Keep the CLI from exiting 0 when a command stops before it finishes.
 *
 * Node exits with code 0 once nothing is left to run, even while a promise the
 * CLI awaits is still pending: a stream that never ends, or a callback that is
 * never called. The command's remaining output never prints, and the exit code
 * reports success for work that never ran.
 */

/** What the CLI prints when the event loop empties before the command settles. */
export const UNSETTLED_EXIT_MESSAGE =
  'Internal error: the command stopped before it finished, so its work is not complete. ' +
  'This is a bug in kici. Run `kici feedback` to see how to report it.';

/** The process surface the guard uses. */
type GuardedProcess = Pick<NodeJS.Process, 'once' | 'off' | 'stderr'> & {
  exitCode?: NodeJS.Process['exitCode'];
};

/**
 * Watch `work` until it settles. If the process is about to exit first, print
 * {@link UNSETTLED_EXIT_MESSAGE} to stderr and set the exit code to 1.
 *
 * `beforeExit` fires only when the event loop empties, never on an explicit
 * `process.exit()`, so a command that exits by itself is not affected.
 */
export function guardUnsettledExit(work: Promise<unknown>, proc: GuardedProcess = process): void {
  const onBeforeExit = (): void => {
    proc.stderr.write(`${UNSETTLED_EXIT_MESSAGE}\n`);
    proc.exitCode = 1;
  };
  proc.once('beforeExit', onBeforeExit);
  const release = (): void => {
    proc.off('beforeExit', onBeforeExit);
  };
  work.then(release, release);
}
