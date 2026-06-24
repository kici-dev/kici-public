---
title: Host restart & wait-for-alive
description: Reboot the host a workflow runs on and continue after it comes back
---

When a KiCI agent runs on a host you are provisioning, a workflow can reboot
that host and resume work once it comes back — the Ansible `reboot` +
`wait_for_connection` pattern, expressed as two jobs pinned to the same host.

## The two-job pattern

Host restart is a **job-boundary** capability: the reboot is the last step of a
"restart" job, and the post-restart work lives in a **separate job** pinned to
the same host that `needs` the restart job. The orchestrator holds the
post-restart job until the host completes a reboot cycle, then dispatches it.

```typescript
import { workflow, job, step, restartHost, waitForHostAlive } from '@kici-dev/sdk';

export default workflow('patch-and-verify', {
  on: [
    /* ... */
  ],
  jobs: [
    // Restart job: apply updates, then reboot. restartHost() MUST be the last step.
    job('patch', {
      runsOn: 'kici:host:box-01',
      steps: [
        step('upgrade', async (ctx) => {
          await ctx.$`apt-get upgrade -y`;
        }),
        restartHost(),
      ],
    }),
    // Post-restart job: pinned to the SAME host, needs the restart job.
    job('verify', {
      runsOn: 'kici:host:box-01',
      needs: ['patch'],
      steps: [
        waitForHostAlive(() => fetch('http://localhost:8080/health')),
        step('check-service', async (ctx) => {
          await ctx.$`systemctl is-active myservice`;
        }),
      ],
    }),
  ],
});
```

## `restartHost()`

`restartHost(opts?)` reboots the host the job runs on. It signals the
orchestrator that a reboot is pending (which holds the post-restart job and
treats the agent's imminent disconnect as expected, not a failure), reports the
step success, and the agent issues the OS reboot once the step completes.

- **Must be the last step** of its job — the job completes before the box goes
  down.
- `deadlineMs` (optional) overrides how long the orchestrator waits for the host
  to return after the reboot. The default is the orchestrator's
  `KICI_HOST_REBOOT_DEADLINE_MS` (15 minutes). If the host does not reconnect by
  the deadline, the held post-restart job fails with a clear "host did not
  return after reboot" reason.
- The reboot command is chosen per operating system (Linux `systemctl reboot`,
  macOS `shutdown -r now`, Windows `shutdown /r /t 0`).

## `waitForHostAlive(probe, opts?)`

`waitForHostAlive()` is the optional first step of the post-restart job. The
baseline "the host is back" guarantee comes for free — the post-restart job only
dispatches after the agent reconnects. `waitForHostAlive(probe)` adds a
**service-readiness** gate on top: it polls `probe` until it resolves, for hosts
where "agent connected" does not yet mean "services ready".

- The probe can return anything (an HTTP response, an open port check, a marker
  file). Any non-null resolution means "ready"; a throw or rejection keeps
  polling.
- `intervalMs` (default 3000) and `timeoutMs` (default 300000) tune the poll. If
  the probe never succeeds within `timeoutMs`, the step fails with "services did
  not come up".

## Same-host pinning

The "same host" relationship is the pin: both jobs target the same host via
`runsOn` (a `kici:host:<id>` label or another label the host carries), and the
post-restart job `needs` the restart job. Durable provisioning hosts MUST set a
stable agent id (`KICI_AGENT_ID`) so the host re-registers under the same
identity after the reboot — that stable identity is what lets the orchestrator
recognise the down-then-up cycle and release the held job.

## Failure behavior

- **Host never returns by the deadline** → the held post-restart job fails.
- **Reboot privilege denied** → the restart step fails with a clear privilege
  error (see the operator note below), and the orchestrator clears the
  reboot-pending hold.
- **`waitForHostAlive` probe never succeeds** → that step fails.

The orchestrator refuses to reboot the host it runs on, so a co-located agent
cannot take down the orchestrator's own box.

## Operator prerequisite: reboot privilege

Rebooting needs host privilege. An agent used for host provisioning must be able
to run the OS reboot primitive — run the agent service with reboot privilege, or
grant a narrow `shutdown` / `systemctl reboot` permission. Agents used for
provisioning generally need broad, near-root host privileges; see the operator
agent documentation for the full posture.
