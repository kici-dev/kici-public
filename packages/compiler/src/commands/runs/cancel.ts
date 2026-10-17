/** kici runs cancel — cancel a run or all in-progress runs on a branch. */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { loadGlobalConfig, type GlobalConfig } from '../../remote/config.js';
import { cancelRunDirect, DirectCancelError } from '../../remote/direct-cancel.js';
import { resolveRunTarget } from '../../remote/target.js';

export interface RunsCancelOptions {
  force?: boolean;
  branch?: string;
  /** Cancel on this orchestrator directly (token from `KICI_ORCHESTRATOR_TOKEN` or `kici connect`). */
  orchestratorUrl?: string;
}

export async function runsCancelCommand(
  runId: string | undefined,
  options: RunsCancelOptions = {},
): Promise<boolean> {
  try {
    if (options.branch && options.orchestratorUrl) {
      logger.error(
        pc.red(
          '--branch cancels through the KiCI Platform; it cannot be combined with --orchestrator-url.',
        ),
      );
      return false;
    }
    // --branch is a Platform operation, so no direct target is resolved for it.
    const direct = options.branch
      ? undefined
      : directCancelTarget(await loadGlobalConfig(), process.env, options.orchestratorUrl);
    if (direct && runId) {
      logger.info(
        `${options.force ? 'Force-cancelling' : 'Cancelling'} run ${pc.cyan(runId)} on ${direct.url}...`,
      );
      const result = await cancelRunDirect(direct.url, direct.token, runId, {
        force: options.force ?? false,
      });
      console.log(cancelOutcomeLine(runId, result.alreadyTerminal, result.cancelledJobs));
      return true;
    }
    const client = await DashboardClient.load();
    if (options.branch) {
      logger.info(`Cancelling all in-progress runs on branch ${pc.cyan(options.branch)}...`);
      const { cancelledRuns = 0 } = await client.cancelByBranch(options.branch);
      console.log(
        cancelledRuns === 0
          ? pc.yellow(`No in-progress runs found on branch ${options.branch}.`)
          : pc.green(
              `Cancelled ${cancelledRuns} run${cancelledRuns !== 1 ? 's' : ''} on branch ${options.branch}.`,
            ),
      );
      return true;
    }
    if (!runId) {
      logger.error(pc.red('Please provide a run ID or use --branch to cancel by branch.'));
      return false;
    }
    logger.info(`${options.force ? 'Force-cancelling' : 'Cancelling'} run ${pc.cyan(runId)}...`);
    const { cancelledJobs = 0, alreadyTerminal } = await client.cancelRun(
      runId,
      options.force ?? false,
    );
    console.log(cancelOutcomeLine(runId, alreadyTerminal, cancelledJobs));
    return true;
  } catch (err) {
    logger.error(
      pc.red(
        err instanceof DashboardClientError || err instanceof DirectCancelError
          ? err.message
          : toErrorMessage(err),
      ),
    );
    return false;
  }
}

/** An already-finished run is left untouched, so it is never reported as cancelled. */
function cancelOutcomeLine(
  runId: string,
  alreadyTerminal: boolean | undefined,
  jobs: number,
): string {
  return alreadyTerminal
    ? pc.yellow(`Run ${runId} had already finished; nothing was cancelled.`)
    : pc.green(`Run ${runId} cancelled (${jobs} job${jobs !== 1 ? 's' : ''} affected).`);
}

/**
 * The orchestrator to cancel on directly, or undefined for the Platform.
 *
 * Direct when this invocation asks for it (`--orchestrator-url`, or
 * `KICI_ORCHESTRATOR_TOKEN` set with `KICI_ORCHESTRATOR_URL` or a saved
 * `kici connect` URL: the precedence `kici run remote` uses), or when a saved
 * direct target is the only target. A saved direct target never overrides a
 * Platform login, which is where a run cancel has always gone.
 */
export function directCancelTarget(
  config: GlobalConfig,
  env: NodeJS.ProcessEnv,
  flagUrl?: string,
): { url: string; token: string } | undefined {
  const resolved = resolveRunTarget({ env, config, flagUrl });
  if (flagUrl && !resolved.ok) throw new Error(resolved.error);
  if (!resolved.ok || resolved.target.kind !== 'direct') return undefined;
  const { target } = resolved;
  if (target.source === 'saved' && config.pat && config.platformEndpoint) return undefined;
  return { url: target.url, token: target.token };
}
