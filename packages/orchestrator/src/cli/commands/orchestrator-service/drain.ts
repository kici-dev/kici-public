/**
 * `kici-admin orchestrator drain` / `resume` CLI verbs.
 *
 * Quiesce a coordinator before an upgrade: stop dispatching new jobs, let
 * in-flight jobs finish, report when quiesced. `--wait` polls status
 * client-side until `jobsRunning` reaches 0 or the timeout elapses; exit codes
 * are scriptable (0 quiesced/initiated, 2 wait timed out, 1 error).
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../../api-client.js';
import { waitForQuiesce } from '../shared/upgrade-safety.js';

// Re-exported so existing importers (and the tests that pin the poller's
// semantics) keep one implementation between the CLI verb and the upgrade.
export { waitForQuiesce };

type Snapshot = { draining: boolean; jobsRunning: number };

function printSnapshot(s: Snapshot): void {
  console.log(`draining=${s.draining} jobsRunning=${s.jobsRunning}`);
}

export function registerOrchestratorDrain(
  orchestrator: Command,
  getClient: () => AdminApiClient,
): void {
  orchestrator
    .command('drain')
    .description('Quiesce this coordinator before upgrading (stop dispatching new jobs)')
    .option('--wait', 'Block until in-flight jobs finish (jobsRunning reaches 0)')
    .option('--timeout <seconds>', 'Max seconds to wait with --wait', '300')
    .option('--status', 'Report drain status without changing it')
    .action(async (opts: { wait?: boolean; timeout: string; status?: boolean }) => {
      const client = getClient();
      try {
        if (opts.status) {
          printSnapshot(await client.drainStatus());
          process.exitCode = 0;
          return;
        }
        printSnapshot(await client.drain('drain'));
        if (!opts.wait) {
          process.exitCode = 0;
          return;
        }
        const timeoutSec = Number(opts.timeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
          console.error(
            `Invalid --timeout: ${opts.timeout} (expected a non-negative number of seconds)`,
          );
          process.exitCode = 1;
          return;
        }
        const r = await waitForQuiesce(() => client.drainStatus(), {
          timeoutMs: timeoutSec * 1000,
          intervalMs: 2000,
        });
        if (r.quiesced) {
          console.log('Quiesced — 0 jobs running.');
          process.exitCode = 0;
        } else {
          console.error(`Timed out with ${r.jobsRunning} job(s) still running.`);
          process.exitCode = 2;
        }
      } catch (err) {
        console.error(`drain failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  orchestrator
    .command('resume')
    .description('Resume dispatching new jobs (undo a drain)')
    .action(async () => {
      try {
        printSnapshot(await getClient().drain('resume'));
        process.exitCode = 0;
      } catch (err) {
        console.error(`resume failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
