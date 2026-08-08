/**
 * kici local commands
 *
 * Manage the warm, per-user local dev orchestrator plane: a real independent
 * orchestrator plus a local Postgres (embedded, with a podman fallback) that
 * `kici run --local` dispatches through. `up` boots or reuses the plane,
 * `status` reports it plus the control commands, `down` stops it, and `logs`
 * prints the orchestrator log path.
 */

import pc from 'picocolors';
import { toErrorMessage } from '@kici-dev/core';
import {
  planeStatus,
  planeDown,
  planeLogPath,
  attachPlane,
  detachPlane,
} from '../local-plane/plane-manager.js';
import type { PlaneStatus, PlaneMode } from '../local-plane/plane-manager.js';
import type { PlaneState } from '../local-plane/plane-liveness.js';
import { resolvePlaneForRun } from '../local-plane/resolve-plane.js';
import { loadGlobalConfig } from '../remote/config.js';

/** Print the control commands a user needs once the plane is running. */
function printControlHints(): void {
  console.log('');
  console.log(pc.dim('Control commands:'));
  console.log(`  ${pc.cyan('kici local status')}   Show plane status`);
  console.log(`  ${pc.cyan('kici local logs')}     Print the orchestrator log path`);
  console.log(`  ${pc.cyan('kici local down')}     Stop the plane`);
}

/**
 * Boot (or reuse) the local dev plane, honoring the durable attachment record.
 *
 * Routes through the same `resolvePlaneForRun` resolver `kici run --local` uses,
 * so the two commands share one plane-resolution path and never diverge: an
 * attached + reachable plane comes up hybrid, an attached-but-unreachable plane
 * falls back to offline with a loud banner, and a never-attached plane comes up
 * offline. `--offline` forces the independent boot (without clearing the durable
 * attachment record — only `detach` does that); `--connected` requires an
 * attached, reachable Platform.
 */
export async function localUpCommand(
  flags: { offline?: boolean; connected?: boolean } = {},
): Promise<boolean> {
  console.log(pc.dim('Starting the local dev plane…'));
  const resolved = await resolvePlaneForRun({
    offline: flags.offline ?? false,
    connected: flags.connected ?? false,
  });
  if ('error' in resolved) {
    console.log(pc.red(`✗ ${resolved.error}`));
    return false;
  }
  const { plane } = resolved;
  const url = plane.url ?? '';
  const pg = pc.dim(`(postgres: ${plane.pgKind ?? 'unknown'})`);
  if (resolved.kind === 'attached') {
    console.log(
      pc.green('✓') +
        ` Local dev plane running (hybrid → Platform, org: ${pc.bold(resolved.orgId)}) at ${pc.bold(url)} ` +
        pg,
    );
  } else {
    console.log(
      pc.green('✓') + ` Local dev plane running (independent/offline) at ${pc.bold(url)} ` + pg,
    );
    if (resolved.kind === 'fallback') {
      console.log(pc.yellow(`  ⚠ Attached, but booted offline: ${resolved.reason}`));
    }
  }
  printControlHints();
  return true;
}

/**
 * Render the branch for a plane port held by a process that is not a KiCI plane
 * orchestrator. Kept apart from the not-serving branch because `kici local down`
 * deliberately refuses to signal such a holder, so pointing at it here would
 * send the operator to a command that cannot act.
 */
function printForeignHolder(status: Awaited<ReturnType<typeof planeStatus>>): void {
  console.log(
    pc.yellow('⚠') +
      ` Port ${pc.bold(String(status.port))} is held by a process that is not a KiCI plane orchestrator.`,
  );
  console.log(pc.dim(`  pid:      ${status.pid ?? 'unknown'}`));
  console.log('The local dev plane cannot start while that process holds the port.');
  console.log(
    `Stop it yourself, or point the plane elsewhere with ${pc.cyan('KICI_LOCAL_ORCH_PORT')}.`,
  );
}

/**
 * Render the branch for a plane port held by a KiCI plane orchestrator that is
 * not serving this config dir: our own stamped orchestrator failing its
 * readiness probe, or a plane no stamp here accounts for. Split out of
 * `localStatusCommand` so each branch stays readable.
 *
 * The two get different headlines because only one of them has been probed:
 * readiness is checked for a plane we stamped, so `unready` is a measurement,
 * while a plane we did not stamp is only known to be holding the port.
 */
function printNotServing(status: Awaited<ReturnType<typeof planeStatus>>): void {
  if (status.state === 'foreign-kici') {
    console.log(
      pc.yellow('⚠') +
        ` Port ${pc.bold(String(status.port))} is held by a KiCI plane orchestrator this config dir did not start.`,
    );
    console.log(pc.dim(`  pid:      ${status.pid ?? 'unknown'}`));
    console.log(pc.dim('  owner:    another KiCI plane — no stamp in this config dir'));
    console.log(`Stop it with ${pc.cyan('kici local down')}.`);
    return;
  }

  console.log(
    pc.yellow('⚠') + ` Local dev plane is running but NOT ready at ${pc.bold(status.url ?? '')}`,
  );
  console.log(pc.dim(`  port:     ${status.port}`));
  console.log(pc.dim(`  pid:      ${status.pid ?? 'unknown'}`));
  if (status.checks && Object.keys(status.checks).length > 0) {
    const rendered = Object.entries(status.checks)
      .map(([name, ok]) => `${name}=${ok}`)
      .join(' ');
    console.log(pc.dim(`  checks:   ${rendered}`));
  }
  console.log(`Stop it with ${pc.cyan('kici local down')}.`);
}

/**
 * The machine-readable projection of a plane status.
 *
 * An explicit allow-list, NOT `JSON.stringify(status)`. `PlaneStatus` carries
 * `adminToken` — the bootstrap admin token the CLI presents to the plane's
 * admin API — so serializing the whole object would publish it on stdout, and
 * from there into any consumer's logs. `attachment` is omitted for the same
 * reason in miniature: no consumer needs it, and a field that is never emitted
 * cannot leak a field added to it later.
 */
export interface LocalStatusJson {
  state: PlaneState;
  running: boolean;
  pid: number | null;
  port: number | null;
  url: string | null;
  pgKind: 'embedded' | 'podman' | null;
  stampVersion: number | null;
  mode: PlaneMode | null;
}

/** Project a PlaneStatus onto the published JSON shape, absent fields as null. */
export function toLocalStatusJson(status: PlaneStatus): LocalStatusJson {
  return {
    state: status.state,
    running: status.running,
    pid: status.pid ?? null,
    port: status.port ?? null,
    url: status.url ?? null,
    pgKind: status.pgKind ?? null,
    stampVersion: status.stampVersion ?? null,
    mode: status.mode ?? null,
  };
}

/** Show the local dev plane status and its control commands. */
export async function localStatusCommand(options?: { json?: boolean }): Promise<boolean> {
  const status = await planeStatus();

  // Every state exits 0 in JSON mode: the state belongs in the payload, and a
  // non-zero exit would be indistinguishable from the failure modes a consumer
  // must treat as "liveness undeterminable".
  if (options?.json) {
    console.log(JSON.stringify(toLocalStatusJson(status)));
    return true;
  }

  if (status.state === 'stopped') {
    console.log(pc.yellow('Local dev plane is not running.'));
    console.log(`Start it with ${pc.cyan('kici local up')}.`);
    return true;
  }

  if (status.state === 'foreign-unknown') {
    printForeignHolder(status);
    return true;
  }

  if (status.state !== 'ready') {
    printNotServing(status);
    return true;
  }

  console.log(pc.green('✓') + ` Local dev plane running at ${pc.bold(status.url ?? '')}`);
  console.log(pc.dim(`  port:     ${status.port}`));
  console.log(pc.dim(`  pid:      ${status.pid ?? 'unknown'}`));
  console.log(pc.dim(`  postgres: ${status.pgKind ?? 'unknown'}`));
  if (status.mode === 'hybrid' && status.attachment) {
    console.log(pc.dim(`  attached: hybrid → Platform (org: ${status.attachment.orgId})`));
  } else {
    console.log(pc.dim('  attached: no (independent/offline)'));
  }
  printControlHints();
  return true;
}

/** Stop the local dev plane, reporting success only once the port is released. */
export async function localDownCommand(): Promise<boolean> {
  console.log(pc.dim('Stopping the local dev plane…'));
  const result = await planeDown();
  if (!result.stopped) {
    console.error(pc.red(`✗ Local dev plane NOT stopped: ${result.reason ?? 'port still held'}`));
    if (result.holderPid !== undefined) {
      console.error(pc.dim(`  holder pid: ${result.holderPid}   port: ${result.port}`));
    }
    return false;
  }
  console.log(pc.green('✓') + ' Local dev plane stopped.');
  return true;
}

/** Print the local dev plane orchestrator log path. */
export async function localLogsCommand(): Promise<boolean> {
  console.log(planeLogPath());
  return true;
}

/**
 * Attach the local dev plane to the hosted Platform so `kici run --local` uses
 * real Platform-minted OIDC + attestation. Mints an org-scoped orchestrator key
 * with the logged-in PAT, then (re)boots the plane hybrid.
 */
export async function localAttachCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();
  if (!config.pat) {
    console.error(pc.red('Not authenticated. Run `kici login` first.'));
    return false;
  }
  if (!config.platformEndpoint) {
    console.error(pc.red('No Platform endpoint configured. Run `kici login` first.'));
    return false;
  }
  const orgId = config.activeOrgId;
  if (!orgId) {
    console.error(
      pc.red('No active organization. Select one with `kici org use <org>` before attaching.'),
    );
    return false;
  }
  try {
    console.log(pc.dim('Attaching the local dev plane to the Platform…'));
    const status = await attachPlane({ apiBase: config.platformEndpoint, pat: config.pat, orgId });
    console.log(
      pc.green('✓') +
        ` Local dev plane attached (hybrid) at ${pc.bold(status.url ?? '')} ` +
        pc.dim(`(org: ${orgId})`),
    );
    console.log(
      pc.dim('`kici run --local` now uses real Platform OIDC + attestation. Detach: ') +
        pc.cyan('kici local detach'),
    );
    return true;
  } catch (err) {
    console.error(pc.red(`Attach failed: ${toErrorMessage(err)}`));
    return false;
  }
}

/** Detach the local dev plane from the Platform and reboot it offline (independent). */
export async function localDetachCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();
  try {
    console.log(pc.dim('Detaching the local dev plane…'));
    await detachPlane({ pat: config.pat });
    console.log(pc.green('✓') + ' Local dev plane detached (independent/offline).');
    return true;
  } catch (err) {
    console.error(pc.red(`Detach failed: ${toErrorMessage(err)}`));
    return false;
  }
}
