/**
 * `kici local`: the warm, per-user local dev plane `kici run --local` dispatches
 * through — a real independent orchestrator plus a local Postgres (embedded,
 * with a podman fallback).
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
import { PLANE_LOG_MAX_MB } from '../local-plane/plane-log.js';
import { loadGlobalConfig } from '../remote/config.js';

function printControlHints(): void {
  console.log('');
  console.log(pc.dim('Control commands:'));
  console.log(`  ${pc.cyan('kici local status')}   Show plane status`);
  console.log(`  ${pc.cyan('kici local logs')}     Print the plane log paths and rotation policy`);
  console.log(`  ${pc.cyan('kici local down')}     Stop the plane`);
}

/**
 * Boots or reuses the plane through the `resolvePlaneForRun` resolver
 * `kici run --local` uses, so the two never diverge: attached and reachable
 * comes up hybrid, attached but unreachable falls back offline with a loud
 * banner, never attached comes up offline. `--offline` forces the independent
 * boot without clearing the attachment record (only `detach` does);
 * `--connected` requires an attached, reachable Platform.
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
 * The plane port is held by a non-KiCI process. `kici local down` refuses to
 * signal such a holder, so this branch never points at it.
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
 * The plane port is held by a KiCI plane orchestrator not serving this config
 * dir: our stamped orchestrator failing readiness, or a plane no stamp here
 * accounts for. The headlines differ because only a plane we stamped is probed,
 * so `unready` is a measurement; the other is only known to hold the port.
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
 * An explicit allow-list, NOT `JSON.stringify(status)`: `PlaneStatus` carries
 * `adminToken`, the plane's bootstrap admin token, which would land on stdout
 * and in consumers' logs. `attachment` is omitted too: no consumer needs it, and
 * a field never emitted cannot leak what is added to it later.
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

/** Absent fields become null. */
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

export async function localStatusCommand(options?: { json?: boolean }): Promise<boolean> {
  const status = await planeStatus();

  // Every state exits 0 in JSON mode: the state belongs in the payload, and a
  // non-zero exit would read as a failure the consumer treats as "liveness
  // undeterminable".
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

/** Reports success only once the port is released. */
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

/**
 * The log path is this command's only stdout line; the rotation policy goes to
 * stderr. The CLI version banner still precedes it, so `$(kici local logs)` is
 * NOT a bare path: read the last stdout line.
 */
export async function localLogsCommand(): Promise<boolean> {
  const logFile = planeLogPath();
  console.log(logFile);
  console.error(
    pc.dim(
      `Rotated to ${logFile}.1 when it reaches ${PLANE_LOG_MAX_MB} MB, at the next plane start. ` +
        `When the plane runs embedded PostgreSQL, its log sits beside it at ${logFile}.pg and rotates the same way.`,
    ),
  );
  return true;
}

/**
 * Attaches the plane to the hosted Platform so `kici run --local` mints OIDC and
 * attestation with the plane's own key under its own issuer, as a deployed
 * orchestrator does. Mints an org-scoped orchestrator key with the logged-in
 * PAT, then reboots the plane hybrid.
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
      pc.dim(
        "`kici run --local` now mints OIDC + attestation with this plane's own key against the real Platform org. Detach: ",
      ) + pc.cyan('kici local detach'),
    );
    return true;
  } catch (err) {
    console.error(pc.red(`Attach failed: ${toErrorMessage(err)}`));
    return false;
  }
}

/** Reboots the plane offline (independent). */
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
