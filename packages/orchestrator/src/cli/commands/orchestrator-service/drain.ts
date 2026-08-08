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

type Snapshot = { draining: boolean; jobsRunning: number };

export interface WaitOpts {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `poll` until jobsRunning hits 0 or the timeout elapses. Pure with an
 * injectable clock + sleep so it is testable without real time.
 */
export async function waitForQuiesce(
  poll: () => Promise<Snapshot>,
  opts: WaitOpts,
): Promise<{ quiesced: boolean; jobsRunning: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const snap = await poll();
    if (snap.jobsRunning === 0) return { quiesced: true, jobsRunning: 0 };
    if (now() >= deadline) return { quiesced: false, jobsRunning: snap.jobsRunning };
    await sleep(opts.intervalMs);
  }
}

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
