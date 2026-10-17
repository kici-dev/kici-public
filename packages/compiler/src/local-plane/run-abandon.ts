/**
 * Close a local-plane run the CLI stops following before it finished.
 *
 * The plane persists a triggered run in its own database. A run left behind
 * when `kici run --local` gives up (no agent picked it up, the follow timed out,
 * the operator pressed Ctrl-C) stays queued or running there, and the next
 * plane start dispatches it again: in the same working tree as the run the
 * operator starts next. So every abort cancels the run before the CLI exits.
 */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { cancelRunDirect } from '../remote/direct-cancel.js';

export async function cancelAbandonedRun(
  planeUrl: string,
  adminToken: string,
  runId: string,
  opts: { quiet?: boolean; cancel?: typeof cancelRunDirect } = {},
): Promise<boolean> {
  try {
    const result = await (opts.cancel ?? cancelRunDirect)(planeUrl, adminToken, runId, {
      force: true,
    });
    if (!opts.quiet && !result.alreadyTerminal) {
      logger.info(
        pc.dim(`Cancelled run ${runId} in the local plane, so it is not dispatched later.`),
      );
    }
    return true;
  } catch (err) {
    logger.warn(
      pc.yellow(
        `Could not cancel run ${runId} in the local plane (${toErrorMessage(err)}). ` +
          `Cancel it with: KICI_ORCHESTRATOR_URL=${planeUrl} KICI_ORCHESTRATOR_TOKEN=<plane admin token> ` +
          `kici runs cancel ${runId} --force`,
      ),
    );
    return false;
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Run `onSignal` (cancel the run, then the caller's cleanup) when the process is
 * interrupted while a run is followed, then exit with the conventional code.
 * Returns the function that uninstalls it.
 *
 * Listeners registered earlier are set aside until then and restored after. On
 * a first plane bootstrap, embedded-postgres registers an exit hook on both
 * signals that exits within a few ticks, before the cancel request can finish,
 * and the run would stay queued. Nothing else needs to run first: this handler
 * exits the process itself once the cancel and the cleanup are done.
 */
export function cancelOnSignal(
  onSignal: () => Promise<unknown>,
  proc: Pick<
    NodeJS.Process,
    'rawListeners' | 'removeAllListeners' | 'on' | 'removeListener' | 'exit'
  > = process,
): () => void {
  const prior = SIGNALS.map((signal) => [signal, proc.rawListeners(signal)] as const);
  for (const signal of SIGNALS) proc.removeAllListeners(signal);
  let fired = false;
  const installed = SIGNALS.map((signal) => {
    const handler = (): void => {
      if (fired) return;
      fired = true;
      void onSignal().finally(() => proc.exit(signal === 'SIGINT' ? 130 : 143));
    };
    proc.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of installed) proc.removeListener(signal, handler);
    for (const [signal, listeners] of prior) {
      for (const listener of listeners) proc.on(signal, listener as (...args: unknown[]) => void);
    }
  };
}
