import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { planePaths, planePorts } from './paths.js';
import { rotatePlaneLogIfOversized } from './plane-log.js';

/** The entry the plane launches in independent (offline) mode. */
export function resolveStandaloneEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@kici-dev/orchestrator/standalone');
}

/** The entry the plane launches in hybrid (Platform-attached) mode. */
export function resolveServerEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@kici-dev/orchestrator/server');
}

/**
 * Cap on one readiness probe, so a socket that accepts then goes silent cannot
 * stall the poll for the HTTP client's multi-minute default and void
 * `awaitOrchestratorReady`'s attempt budget.
 */
const READY_PROBE_TIMEOUT_MS = 5_000;

export async function orchestratorReady(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS),
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

export interface SpawnOrchestratorOptions {
  /** Bootstrap admin token the CLI presents to the plane's admin API. */
  adminToken: string;
  /** 64 hex chars. Enables the secrets subsystem, which gates the admin API routes the CLI drives. */
  secretKey: string;
  /** Bare-metal scaler YAML (KICI_SCALER_CONFIG_PATH). */
  scalerConfigFile: string;
  /**
   * The dev-signed identity's EC P-256 private JWK. Enables local OIDC mint and
   * dev-signed provenance (issuer `kici-local`). Independent boot only: the
   * hybrid boot mints with the orchestrator's own signing key.
   */
  devIdentityKeyFile?: string;
  /**
   * Boot HYBRID, attached to the Platform relay. OIDC and attestation then mint
   * with the orchestrator's own signing key under its own issuer, as a deployed
   * orchestrator does; the local dev signer is never consulted.
   */
  attach?: {
    /** Orchestrator KICI_PLATFORM_URL — a ws(s)://…/ws relay URL. */
    platformWsUrl: string;
    /** Org-scoped orchestrator key (kici_ok_…) presented on WS auth. */
    platformToken: string;
  };
}

/**
 * Spawn the orchestrator detached, logging to the plane log, and return at once.
 * The bare-metal scaler makes a dispatched job auto-spawn an ephemeral agent.
 *
 * Returning before ready is deliberate: the caller records the pid BEFORE the
 * readiness wait, so a failed wait or a CLI dying mid-boot cannot leave an
 * unidentifiable running orchestrator.
 */
export function spawnOrchestratorProcess(
  databaseUrl: string,
  opts: SpawnOrchestratorOptions,
): { pid: number; port: number } {
  const { orchestrator: port } = planePorts();
  const { logFile, root, cacheDir } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  // Boot is the one moment nothing holds the log open (the caller's reclaim
  // stopped its writer), so rotation is safe only here.
  rotatePlaneLogIfOversized(logFile);
  const out = fs.openSync(logFile, 'a');
  // Strip inherited KICI_* vars: the orchestrator refuses to start on an unknown
  // one (such as the plane's own KICI_LOCAL_* / KICI_CONFIG_DIR).
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('KICI_')) baseEnv[key] = value;
  }
  const commonEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    KICI_PORT: String(port),
    KICI_DATABASE_URL: databaseUrl,
    KICI_AGENT_AUTH: 'none',
    // Everything the plane runs lives on this host. Binding loopback is what
    // makes `KICI_AGENT_AUTH: 'none'` safe on a shared network, and
    // `assertAgentAuthBindSafe` enforces it.
    KICI_HOST: '127.0.0.1',
    KICI_AUTO_MIGRATE: 'true',
    // One process never sees a Raft peer. This sets the election grace period to
    // 0 (`config.cluster.singleNode ? 0 : …`), so the node self-elects on its first
    // election timer instead of waiting the 60s peer-discovery window. `/ready` reports the
    // boot latch, not leadership, so otherwise a cold plane looks up while no
    // dispatch can land, and the CLI's 60s trigger budget expires first.
    KICI_CLUSTER_SINGLE_NODE: 'true',
    KICI_DATA_DIR: root,
    KICI_BOOTSTRAP_ADMIN_TOKEN: opts.adminToken,
    KICI_SECRET_KEY: opts.secretKey,
    KICI_SCALER_CONFIG_PATH: opts.scalerConfigFile,
    KICI_WEBHOOK_PUBLIC_URL: `http://127.0.0.1:${port}`,
    // For ctx.cache; the agent fetches blobs from the plane's /api/v1/cache/blob/ route.
    KICI_STORAGE_TYPE: 'filesystem',
    KICI_STORAGE_FS_PATH: cacheDir,
    KICI_STORAGE_FS_BASE_URL: `http://127.0.0.1:${port}`,
  };

  let entry: string;
  let modeEnv: NodeJS.ProcessEnv;
  if (opts.attach) {
    // server.ts always builds the real SecretResolver; OIDC/attestation mint with
    // the orchestrator's own key (db custody, wrapped by KICI_SECRET_KEY) under
    // the plane's issuer. The dev-signed identity envs are deliberately NOT set:
    // the choke point prefers orchestrator-owned signing.
    entry = resolveServerEntry();
    modeEnv = {
      KICI_MODE: 'hybrid',
      KICI_PLATFORM_URL: opts.attach.platformWsUrl,
      KICI_PLATFORM_TOKEN: opts.attach.platformToken,
      KICI_ORCHESTRATOR_PROVENANCE_ISSUER: `http://127.0.0.1:${port}`,
    };
  } else {
    // Dispatch-time context-scoped secrets, plus a local ES256 signer that mints
    // `ctx.kici.oidc.token()` and `ctx.attestProvenance()` under the clearly
    // non-prod issuer `kici-local`. Only the local dev plane sets these.
    entry = resolveStandaloneEntry();
    modeEnv = {
      KICI_MODE: 'independent',
      KICI_INDEPENDENT_SECRETS: 'true',
      KICI_INDEPENDENT_IDENTITY: 'true',
      KICI_DEV_IDENTITY_KEY_FILE: opts.devIdentityKeyFile,
      KICI_PROVENANCE_ISSUER: 'kici-local',
    };
  }

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...commonEnv, ...modeEnv },
  });
  child.unref();
  return { pid: child.pid!, port };
}

/** Poll `/ready`; throws once the attempts run out. */
export async function awaitOrchestratorReady(
  port: number,
  attempts = 120,
  intervalMs = 500,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await orchestratorReady(port)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('local orchestrator did not become ready');
}
