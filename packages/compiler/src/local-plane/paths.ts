import os from 'node:os';
import path from 'node:path';

/**
 * On-disk layout version of the local dev plane. Bumped when the state-dir
 * structure changes incompatibly, so a stamped plane from an older layout is
 * recreated rather than reused.
 */
export const PLANE_STAMP_VERSION = 3;

/**
 * Root directory of the local dev plane's state, following the same
 * `KICI_CONFIG_DIR` → `~/.kici` convention the rest of the CLI uses.
 */
export function planeRoot(): string {
  const base = process.env.KICI_CONFIG_DIR ?? path.join(os.homedir(), '.kici');
  return path.join(base, 'local');
}

/**
 * Absolute paths for every artefact the plane persists under its state root.
 */
export function planePaths(): {
  root: string;
  pgData: string;
  pidfile: string;
  stampFile: string;
  logFile: string;
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
    socketDir: path.join(root, 'sock'),
    // Bootstrap admin token the CLI presents to the plane's admin API (mode 0600).
    adminTokenFile: path.join(root, 'admin-token'),
    // Platform orchestrator key (mode 0600) the plane presents when booted
    // hybrid/attached. Kept out of the stamp JSON so the token never lands in a
    // world-readable file. Absent when the plane is independent/offline.
    platformTokenFile: path.join(root, 'platform-token'),
    // Durable attachment record ({ platformWsUrl, platformApiBase, orgId,
    // keyId } — never the token). Survives `kici local down` so a stopped-but-
    // attached plane re-boots hybrid on the next `kici local up` or
    // `kici run --local` (both route through `resolvePlaneForRun`, which honors
    // this record). `kici local up --offline` boots independent for that session
    // without clearing it; only `detach` clears the record.
    attachmentFile: path.join(root, 'attachment.json'),
    // Local master secret key (freshly generated, mode 0600). Enables the plane
    // orchestrator's secrets subsystem, which gates its admin API surface.
    secretKeyFile: path.join(root, 'secret-key'),
    // Bare-metal scaler YAML the plane orchestrator loads via KICI_SCALER_CONFIG_PATH.
    scalerConfigFile: path.join(root, 'scaler.yaml'),
    // Executable wrapper the bare-metal scaler spawns (execs `node <kici-agent>`).
    agentWrapperFile: path.join(root, 'agent-wrapper.sh'),
    // Dev-signed identity keypair dir (populated in a later step; reserved here).
    devIdentityDir: path.join(root, 'dev-identity'),
    // Filesystem cache-storage dir so ctx.cache save/restore works offline.
    cacheDir: path.join(root, 'cache'),
  };
}

/**
 * Fixed localhost ports for the plane's orchestrator (HTTP+WS) and Postgres.
 * Overridable via `KICI_LOCAL_ORCH_PORT` / `KICI_LOCAL_PG_PORT`.
 */
export function planePorts(): { orchestrator: number; postgres: number } {
  const orchestrator = Number(process.env.KICI_LOCAL_ORCH_PORT ?? 4319);
  const postgres = Number(process.env.KICI_LOCAL_PG_PORT ?? 45432);
  return { orchestrator, postgres };
}
