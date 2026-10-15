import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * On-disk layout version of the local dev plane. Bump it when an older build's
 * plane cannot be reused (incompatible state-dir layout, or a database this
 * build cannot migrate), so it is recreated.
 */
export const PLANE_STAMP_VERSION = 5;

/**
 * The plane's state root under `KICI_CONFIG_DIR` (else `~/.kici`).
 *
 * RESOLVED THROUGH SYMLINKS, deliberately. The plane is a singleton on fixed
 * ports, so a throwaway, credential-free config dir may symlink `local` at the
 * durable one to reuse the warm plane. Unresolved, Postgres would hold its data
 * dir open through that temp path and PANIC when it is removed (`could not
 * open file "<tmp>/local/pgdata/global/pg_control"`), taking the plane down.
 *
 * A path that does not exist yet resolves to itself: a fresh plane creates it.
 */
export function planeRoot(): string {
  const base = process.env.KICI_CONFIG_DIR ?? path.join(os.homedir(), '.kici');
  const root = path.join(base, 'local');
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

export function planePaths(): {
  root: string;
  pgData: string;
  pidfile: string;
  stampFile: string;
  logFile: string;
  pgLogFile: string;
  pgBootstrapStamp: string;
  socketDir: string;
  adminTokenFile: string;
  platformTokenFile: string;
  attachmentFile: string;
  secretKeyFile: string;
  scalerConfigFile: string;
  agentWrapperFile: string;
  devIdentityDir: string;
  cacheDir: string;
} {
  const root = planeRoot();
  return {
    root,
    pgData: path.join(root, 'pgdata'),
    pidfile: path.join(root, 'plane.pid'),
    stampFile: path.join(root, 'stamp.json'),
    logFile: path.join(root, 'orchestrator.log'),
    // Postmaster log for `pg_ctl -l`, named here so the file pg_ctl opens and
    // the file rotation renames cannot drift apart.
    pgLogFile: path.join(root, 'orchestrator.log.pg'),
    // Written once the embedded cluster holds the `kici_local` database; its
    // absence makes the next start finish an interrupted bootstrap.
    pgBootstrapStamp: path.join(root, 'pgdata.bootstrapped'),
    socketDir: path.join(root, 'sock'),
    // Mode 0600.
    adminTokenFile: path.join(root, 'admin-token'),
    // Platform orchestrator key for a hybrid boot (mode 0600), kept out of the
    // stamp so it never lands in a world-readable file. Absent when independent.
    platformTokenFile: path.join(root, 'platform-token'),
    // Durable attachment record (never the token). It survives `kici local down`,
    // so the next `kici local up` or `kici run --local` (via
    // `resolvePlaneForRun`) re-boots hybrid. `kici local up --offline` boots
    // independent without clearing it; only `detach` clears it.
    attachmentFile: path.join(root, 'attachment.json'),
    // Master secret key (mode 0600); see readOrCreateSecretKey.
    secretKeyFile: path.join(root, 'secret-key'),
    // Loaded via KICI_SCALER_CONFIG_PATH.
    scalerConfigFile: path.join(root, 'scaler.yaml'),
    // The bare-metal scaler spawns it; it execs `node <kici-agent>`.
    agentWrapperFile: path.join(root, 'agent-wrapper.sh'),
    // Dev-signed identity keypair; see readOrCreateDevIdentity.
    devIdentityDir: path.join(root, 'dev-identity'),
    // Backs ctx.cache offline.
    cacheDir: path.join(root, 'cache'),
  };
}

/** Fixed localhost ports, overridable via `KICI_LOCAL_ORCH_PORT` / `KICI_LOCAL_PG_PORT`. */
export function planePorts(): { orchestrator: number; postgres: number } {
  const orchestrator = Number(process.env.KICI_LOCAL_ORCH_PORT ?? 4319);
  const postgres = Number(process.env.KICI_LOCAL_PG_PORT ?? 45432);
  return { orchestrator, postgres };
}
