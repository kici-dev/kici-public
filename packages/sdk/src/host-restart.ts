/**
 * Workflow-level host restart + wait-for-host-alive steps.
 *
 * KiCI agents run ON each host while executing a job, so a workflow can reboot
 * the machine it runs on (the Ansible `reboot` + `wait_for_connection` pattern,
 * adapted to KiCI's no-remote-exec model). The flow is job-boundary:
 *
 * - `restartHost()` is the LAST step of a "restart" job. It signals the
 *   orchestrator that this host is about to reboot (which holds the pinned
 *   post-restart job and treats the imminent disconnect as expected), reports
 *   success, and the agent issues the OS reboot once the step completes.
 * - The post-restart work is a SEPARATE job pinned to the same host
 *   (`runsOn: [hostId]`) that `needs` the restart job. The orchestrator holds
 *   it until the host completes a reboot cycle, then dispatches it.
 * - `waitForHostAlive(probe)` is the optional first step of that post-restart
 *   job: the "host is back" guarantee comes free from the pinned-hold (the job
 *   only dispatches after the agent reconnects); this step adds a
 *   service-readiness gate for hosts where "agent connected" ≠ "services ready".
 */

import { waitForStep } from './wait-for.js';
import { step } from './step.js';
import type { Step } from './types.js';

export interface WaitForHostAliveOptions {
  /** Step name surfaced in logs. Defaults to 'wait-for-host-alive'. */
  name?: string;
  /** Time between successive probe invocations, ms. Defaults to 3000. */
  intervalMs?: number;
  /** Total time budget for readiness, ms. Defaults to 300000 (5 min). */
  timeoutMs?: number;
}

/**
 * Optional first step of a post-restart job. Polls a readiness probe until it
 * resolves (services back up after a reboot). The host being reconnected is
 * already guaranteed by the pinned-hold; this gates on service readiness.
 *
 * A probe that throws/rejects keeps polling (the `waitFor` swallow-errors
 * default — the "poll until healthy" pattern). Any non-null resolution means
 * "ready". Exceeding `timeoutMs` fails the step ("services did not come up").
 */
export function waitForHostAlive(
  probe: () => Promise<unknown> | unknown,
  opts: WaitForHostAliveOptions = {},
): Step<unknown> {
  return waitForStep(opts.name ?? 'wait-for-host-alive', {
    check: async () => {
      const v = await probe();
      // `null`/`undefined` mean "keep polling"; everything else means "ready".
      return v ?? true;
    },
    intervalMs: opts.intervalMs ?? 3000,
    timeoutMs: opts.timeoutMs ?? 300_000,
  }) as Step<unknown>;
}

export interface RestartHostOptions {
  /**
   * Max time the orchestrator waits for the host to return after the reboot,
   * ms. Defaults to the orchestrator's `KICI_HOST_REBOOT_DEADLINE_MS`.
   */
  deadlineMs?: number;
}

/**
 * Reboot the host this job runs on. MUST be the last step of a "restart" job;
 * the post-restart work goes in a separate job that `needs` this one and is
 * pinned to the same host (`runsOn: [hostId]`). The orchestrator holds that job
 * until the host completes a reboot cycle, then dispatches it.
 *
 * The step signals the orchestrator (reboot-pending) and reports success; the
 * agent issues the actual OS reboot after the step completes. Rebooting needs
 * host privilege: if the OS reboot primitive is denied, the step fails with a
 * clear privilege error and the orchestrator clears the reboot-pending flag.
 */
export function restartHost(opts: RestartHostOptions = {}): Step<void> {
  return step('restart-host', {
    run: async (ctx) => {
      ctx.log.info('Requesting host reboot…');
      await ctx.kici.host.requestReboot({ deadlineMs: opts.deadlineMs });
      ctx.log.info('Reboot acknowledged; host will reboot after this step completes.');
    },
  });
}
