/**
 * External-actor agent re-stage + restart (fleet auto-upgrade apply).
 *
 * Runs in the OPS agent (the one holding `kici:capability:ssh-transport`) —
 * never on the target host itself, so there is NO self-update-handoff: an
 * external actor swaps the bytes and restarts the target's agent, which
 * reconnects on its OWN persistent token (this function never mints or handles
 * a token). The install is folder-anchored (mirroring the versioned-upgrade
 * layout): the target version is staged into `<installDir>/kici-agent-<version>`
 * and an atomic symlink swap makes it current, so a stage failure aborts BEFORE
 * the swap and never leaves a half-upgraded install. Idempotent — a box already
 * on the target version is a no-op.
 */
import path from 'node:path';
import type { AgentPlatform } from '@kici-dev/shared';
import { sshExec, type SshDeps } from './ssh-exec.js';
import type { HostReach } from './reach.js';
import { probeTargetPlatform } from './probe-platform.js';
import { stageAgentPayload, type DeliveryMode } from './stage-agent-payload.js';
import type { AgentPayloadSource } from './payload-source.js';

/** Default folder-anchored install base for a permanent fleet agent. */
const DEFAULT_INSTALL_DIR = '/opt/kici-agent';

/**
 * How to drain + restart the target's agent after the swap. The ops agent runs
 * `stop` (a graceful drain — SIGTERM + grace) then `start`. For a systemd unit
 * this is `systemctl --user restart <svc>`; for a bare-process fixture it is a
 * kill + relaunch of the install's own launcher (the box's persistent token
 * lives in its env, so no reconnect material is threaded here).
 */
export interface RestartSpec {
  stop: string;
  start: string;
}

export interface RestageOpts {
  /** Target platform; probed over SSH when omitted. */
  platform?: AgentPlatform;
  /** Target version to converge the host onto (the orchestrator's version). */
  version: string;
  /** How the payload reaches the box (ssh-push | s3-direct). */
  delivery: DeliveryMode;
  /** Folder-anchored install base (default `/opt/kici-agent`). */
  installDir?: string;
  /** Drain + restart commands run after the atomic swap. */
  restart: RestartSpec;
}

export interface RestageDeps extends SshDeps {
  /** Payload source for the `ssh-push` delivery path (unused for `s3-direct`). */
  payloadSource?: AgentPayloadSource;
  /** Ops-agent-side file-hash boundary, injectable for tests. */
  hashLocalFile?: (filePath: string) => Promise<string>;
}

/** Single-quote a value for safe embedding in a remote shell command. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The versioned payload directory for a version under the install base. */
function versionDir(installDir: string, version: string): string {
  return path.posix.join(installDir, `kici-agent-${version}`);
}

/**
 * Read the version the `kici-agent` symlink currently points at, or null when
 * no install is present. The symlink target is `kici-agent-<version>`.
 */
async function readCurrentVersion(
  reach: HostReach,
  privateKey: string,
  installDir: string,
  deps: RestageDeps,
): Promise<string | null> {
  const link = path.posix.join(installDir, 'kici-agent');
  const res = await sshExec(
    reach,
    privateKey,
    `readlink ${shQuote(link)} 2>/dev/null || true`,
    {},
    deps,
  );
  const target = res.stdout.trim();
  const match = /(?:^|\/)kici-agent-(.+)$/.exec(target);
  return match ? match[1]! : null;
}

/**
 * Atomically point `<installDir>/kici-agent` at the target version directory.
 * `ln -sfn` onto a temp name + `mv -T` is a single rename, so a reader never
 * sees a missing symlink. The target is stored relative so the tree is movable.
 */
async function swapInstall(
  reach: HostReach,
  privateKey: string,
  installDir: string,
  version: string,
  deps: RestageDeps,
): Promise<void> {
  const link = path.posix.join(installDir, 'kici-agent');
  const tmp = `${link}.swap`;
  const command = [
    `ln -sfn ${shQuote(`kici-agent-${version}`)} ${shQuote(tmp)}`,
    `mv -T ${shQuote(tmp)} ${shQuote(link)}`,
  ].join(' && ');
  const res = await sshExec(reach, privateKey, command, {}, deps);
  if (res.exitCode !== 0) {
    throw new Error(
      `install swap on ${reach.agentId} failed: exit ${res.exitCode}${res.stderr ? `\n${res.stderr}` : ''}`,
    );
  }
}

/** Run the drain (stop) then the restart (start) over SSH. */
async function drainAndRestart(
  reach: HostReach,
  privateKey: string,
  restart: RestartSpec,
  deps: RestageDeps,
): Promise<void> {
  const stopRes = await sshExec(reach, privateKey, restart.stop, {}, deps);
  if (stopRes.exitCode !== 0) {
    throw new Error(
      `agent drain on ${reach.agentId} failed: exit ${stopRes.exitCode}${stopRes.stderr ? `\n${stopRes.stderr}` : ''}`,
    );
  }
  const startRes = await sshExec(reach, privateKey, restart.start, {}, deps);
  if (startRes.exitCode !== 0) {
    throw new Error(
      `agent restart on ${reach.agentId} failed: exit ${startRes.exitCode}${startRes.stderr ? `\n${startRes.stderr}` : ''}`,
    );
  }
}

/**
 * Re-stage the target version onto `reach` and restart its agent. Returns
 * `{ restaged: false }` when the host is already on the target version (no
 * stage, no swap, no restart), `{ restaged: true }` when this call swapped it.
 */
export async function restageAgent(
  reach: HostReach,
  privateKey: string,
  opts: RestageOpts,
  deps: RestageDeps,
): Promise<{ restaged: boolean }> {
  const installDir = opts.installDir ?? DEFAULT_INSTALL_DIR;

  // Idempotent: a box already on the target version needs no re-stage.
  const current = await readCurrentVersion(reach, privateKey, installDir, deps);
  if (current === opts.version) return { restaged: false };

  const platform = opts.platform ?? (await probeTargetPlatform(reach, privateKey, deps));

  // Stage (verify + extract) into the version-keyed dir. stageAgentPayload
  // throws on any verify/extract failure, so the swap below is only reached on
  // a fully-verified stage — never a half-upgrade.
  await stageAgentPayload(
    reach,
    privateKey,
    { platform, version: opts.version, delivery: opts.delivery },
    {
      spawnFn: deps.spawnFn,
      payloadSource: deps.payloadSource,
      extractDir: versionDir(installDir, opts.version),
      hashLocalFile: deps.hashLocalFile,
    },
  );

  await swapInstall(reach, privateKey, installDir, opts.version, deps);
  await drainAndRestart(reach, privateKey, opts.restart, deps);
  return { restaged: true };
}
