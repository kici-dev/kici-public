/**
 * Node exits 0 once nothing is left to run, even while an awaited promise is
 * pending (a stream that never ends, a callback never called), so a command
 * that stopped early would report success for work that never ran.
 */

export const UNSETTLED_EXIT_MESSAGE =
  'Internal error: the command stopped before it finished, so its work is not complete. ' +
  'This is a bug in kici. Run `kici feedback` to see how to report it.';

type GuardedProcess = Pick<NodeJS.Process, 'once' | 'off' | 'stderr'> & {
  exitCode?: NodeJS.Process['exitCode'];
};

/**
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
