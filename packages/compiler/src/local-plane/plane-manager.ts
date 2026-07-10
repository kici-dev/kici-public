import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { planePaths, planePorts, PLANE_STAMP_VERSION } from './paths.js';
import { startPlanePostgres, stopPlanePostgres } from './postgres.js';
import { spawnOrchestrator, orchestratorReady } from './orchestrator-process.js';
import { writeScalerConfig } from './scaler-config.js';
import {
  derivePlatformWsUrl,
  mintOrchestratorKey,
  revokeOrchestratorKey,
} from './platform-attach.js';

declare const KICI_VERSION: string;
const kiciVersion = typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.0';

/** Whether the plane runs offline (independent) or attached to the Platform (hybrid). */
export type PlaneMode = 'independent' | 'hybrid';

/**
 * Attachment record for a hybrid plane: the Platform relay it dials, the org it
 * is scoped to, and the Platform api_keys id of its minted orchestrator key (for
 * later revoke). The orchestrator token itself is NEVER stored here — it lives
 * in a sibling 0600 file so it can't land in a world-readable stamp.
 */
export interface PlaneAttachment {
  /** Orchestrator KICI_PLATFORM_URL — a ws(s)://…/ws relay URL. */
  platformWsUrl: string;
  /** HTTPS Platform API base (provenance/verify context, key revoke). */
  platformApiBase: string;
  orgId: string;
  /** Platform api_keys id of the minted orchestrator key. */
  keyId: string;
}

/** On-disk record of the running plane, written on boot, read on status/down. */
export interface PlaneStamp {
  orchestratorPid: number;
  port: number;
  pgKind: 'embedded' | 'podman';
  kiciVersion: string;
  stampVersion: number;
  /** Offline (independent) vs attached (hybrid). Absent (legacy) reads as independent. */
  mode?: PlaneMode;
}

export interface PlaneStatus {
  running: boolean;
  pid?: number;
  port?: number;
  pgKind?: 'embedded' | 'podman';
  stampVersion?: number;
  url?: string;
  /** Bootstrap admin token the CLI presents to the plane's admin API. */
  adminToken?: string;
  /** Offline (independent) vs attached (hybrid). */
  mode: PlaneMode;
  /** Present iff mode === 'hybrid'. */
  attachment?: PlaneAttachment;
}

/**
 * Read the plane's persisted Platform orchestrator token (mode 0600), or null
 * when the plane is independent/offline. Kept out of the stamp so the token
 * never lands in a world-readable file.
 */
export function readPlatformToken(): string | null {
  try {
    const t = fs.readFileSync(planePaths().platformTokenFile, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Persist the Platform orchestrator token (mode 0600). */
export function writePlatformToken(token: string): void {
  const { platformTokenFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(platformTokenFile, token, { mode: 0o600 });
}

/** Remove the persisted Platform orchestrator token (on detach). */
export function clearPlatformToken(): void {
  fs.rmSync(planePaths().platformTokenFile, { force: true });
}

/**
 * Read the durable attachment record (survives `kici local down`), or null when
 * the plane is not attached. This — not the running stamp — is the source of
 * truth for "is this plane attached to the Platform".
 */
export function readAttachment(): PlaneAttachment | null {
  try {
    return JSON.parse(fs.readFileSync(planePaths().attachmentFile, 'utf-8')) as PlaneAttachment;
  } catch {
    return null;
  }
}

/** Persist the durable attachment record (never the token). */
export function writeAttachment(attachment: PlaneAttachment): void {
  const { attachmentFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(attachmentFile, JSON.stringify(attachment, null, 2));
}

/** Remove the durable attachment record (on detach). */
export function clearAttachment(): void {
  fs.rmSync(planePaths().attachmentFile, { force: true });
}

/**
 * Read the plane's persisted bootstrap admin token, generating + persisting one
 * (mode 0600) on first boot. A warm plane reuses the same token across CLI
 * invocations so a running orchestrator keeps accepting the CLI's admin calls.
 */
export function readOrCreateAdminToken(): string {
  const { adminTokenFile, root } = planePaths();
  try {
    const existing = fs.readFileSync(adminTokenFile, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Missing / unreadable — generate a fresh token below.
  }
  fs.mkdirSync(root, { recursive: true });
  const token = `kici-local-${randomBytes(24).toString('hex')}`;
  fs.writeFileSync(adminTokenFile, token, { mode: 0o600 });
  return token;
}

/** Read the plane's admin token without generating one (null when absent). */
export function planeAdminToken(): string | null {
  try {
    const t = fs.readFileSync(planePaths().adminTokenFile, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Read the plane's local master secret key, generating + persisting a fresh 64
 * hex-char key (mode 0600) on first boot. Stable across boots so DB-encrypted
 * material stays decryptable. Freshly generated — never derived from any sops
 * secret. Enables the orchestrator's secrets subsystem, which gates its admin
 * API surface.
 */
export function readOrCreateSecretKey(): string {
  const { secretKeyFile, root } = planePaths();
  try {
    const existing = fs.readFileSync(secretKeyFile, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Missing / unreadable — generate a fresh key below.
  }
  fs.mkdirSync(root, { recursive: true });
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyFile, key, { mode: 0o600 });
  return key;
}

/** Absolute path of the dev-signed identity's private JWK key file. */
export function devIdentityKeyFile(): string {
  return path.join(planePaths().devIdentityDir, 'identity.jwk');
}

/** Absolute path of the dev-signed identity's public JWK (written by the plane orchestrator). */
export function devIdentityPublicJwkFile(): string {
  return path.join(planePaths().devIdentityDir, 'identity.pub.jwk');
}

/**
 * Read the plane's dev-signed identity keypair, generating + persisting a fresh
 * EC P-256 private JWK (mode 0600) on first boot. Stable across boots so a
 * `kici local trust-root` export stays valid for previously-minted tokens.
 * Freshly generated — NEVER derived from any sops secret or real key. Only the
 * private key is written here; the plane orchestrator derives + writes the
 * public JWK next to it. Returns the private-key file path passed to the
 * orchestrator via KICI_DEV_IDENTITY_KEY_FILE.
 */
export function readOrCreateDevIdentity(): string {
  const keyFile = devIdentityKeyFile();
  try {
    const existing = fs.readFileSync(keyFile, 'utf-8').trim();
    if (existing) return keyFile;
  } catch {
    // Missing / unreadable — generate a fresh keypair below.
  }
  fs.mkdirSync(planePaths().devIdentityDir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  fs.writeFileSync(keyFile, JSON.stringify(jwk, null, 2), { mode: 0o600 });
  return keyFile;
}

function readStamp(): PlaneStamp | null {
  try {
    return JSON.parse(fs.readFileSync(planePaths().stampFile, 'utf-8')) as PlaneStamp;
  } catch {
    return null;
  }
}

function writeStamp(stamp: PlaneStamp): void {
  const { root, stampFile, pidfile } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(stampFile, JSON.stringify(stamp, null, 2));
  fs.writeFileSync(pidfile, String(stamp.orchestratorPid));
}

function orchestratorUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Absolute path of the plane orchestrator's log file. */
export function planeLogPath(): string {
  return planePaths().logFile;
}

/** Read the plane's current status by probing `/ready` against the stamped port. */
export async function planeStatus(): Promise<PlaneStatus> {
  const stamp = readStamp();
  const port = stamp?.port ?? planePorts().orchestrator;
  if (!(await orchestratorReady(port))) {
    return {
      running: false,
      mode: stamp?.mode ?? 'independent',
      attachment: readAttachment() ?? undefined,
    };
  }
  return {
    running: true,
    pid: stamp?.orchestratorPid,
    port,
    pgKind: stamp?.pgKind,
    stampVersion: stamp?.stampVersion,
    url: orchestratorUrl(port),
    adminToken: planeAdminToken() ?? undefined,
    mode: stamp?.mode ?? 'independent',
    attachment: readAttachment() ?? undefined,
  };
}

/** Attach parameters for a hybrid plane boot (see attachPlane). */
export interface PlaneUpAttach {
  platformWsUrl: string;
  platformToken: string;
  platformApiBase: string;
  orgId: string;
  keyId: string;
}

export interface PlaneUpOptions {
  /** Boot the plane hybrid (attached to the Platform) instead of independent. */
  attach?: PlaneUpAttach;
}

/**
 * Start (or reuse) the local dev plane. Idempotent: a healthy running plane
 * **whose stamped mode matches the requested mode** is returned as-is; a mode
 * change (independent↔hybrid) forces a teardown + reboot. Otherwise Postgres +
 * the orchestrator are booted and a fresh stamp + pidfile are written. When
 * `attach` is present the orchestrator boots hybrid against the Platform relay;
 * otherwise it boots independent with the dev-signed identity.
 */
export async function planeUp(opts: PlaneUpOptions = {}): Promise<PlaneStatus> {
  const { orchestrator: port } = planePorts();
  const existing = readStamp();
  const requestedMode: PlaneMode = opts.attach ? 'hybrid' : 'independent';

  // Staleness: an incompatible on-disk layout (stampVersion bump) cannot be
  // migrated in place, so tear the plane down and wipe the data dir before a
  // fresh boot. A kiciVersion-only change keeps the data and relies on the
  // orchestrator's boot migration (KICI_AUTO_MIGRATE=true).
  if (existing && existing.stampVersion !== PLANE_STAMP_VERSION) {
    await planeDown();
    fs.rmSync(planePaths().pgData, { recursive: true, force: true });
  } else if (
    (existing?.mode ?? 'independent') !== requestedMode &&
    (await orchestratorReady(port))
  ) {
    // A running plane in the other mode must be rebooted to switch modes.
    await planeDown();
  } else if (await orchestratorReady(port)) {
    return {
      running: true,
      pid: existing?.orchestratorPid,
      port,
      pgKind: existing?.pgKind,
      stampVersion: existing?.stampVersion,
      url: orchestratorUrl(port),
      adminToken: planeAdminToken() ?? undefined,
      mode: existing?.mode ?? 'independent',
      attachment: readAttachment() ?? undefined,
    };
  }

  const adminToken = readOrCreateAdminToken();
  const secretKey = readOrCreateSecretKey();
  const scalerConfigFile = writeScalerConfig(port);
  const pg = await startPlanePostgres();

  let orch: { pid: number; port: number };
  if (opts.attach) {
    writePlatformToken(opts.attach.platformToken);
    writeAttachment({
      platformWsUrl: opts.attach.platformWsUrl,
      platformApiBase: opts.attach.platformApiBase,
      orgId: opts.attach.orgId,
      keyId: opts.attach.keyId,
    });
    orch = await spawnOrchestrator(pg.url, {
      adminToken,
      secretKey,
      scalerConfigFile,
      attach: {
        platformWsUrl: opts.attach.platformWsUrl,
        platformToken: opts.attach.platformToken,
      },
    });
  } else {
    const devIdentityKey = readOrCreateDevIdentity();
    orch = await spawnOrchestrator(pg.url, {
      adminToken,
      secretKey,
      scalerConfigFile,
      devIdentityKeyFile: devIdentityKey,
    });
  }

  const stamp: PlaneStamp = {
    orchestratorPid: orch.pid,
    port: orch.port,
    pgKind: pg.kind,
    kiciVersion,
    stampVersion: PLANE_STAMP_VERSION,
    mode: requestedMode,
  };
  writeStamp(stamp);
  return {
    running: true,
    pid: orch.pid,
    port: orch.port,
    pgKind: pg.kind,
    stampVersion: PLANE_STAMP_VERSION,
    url: orchestratorUrl(orch.port),
    adminToken,
    mode: requestedMode,
    attachment: readAttachment() ?? undefined,
  };
}

/**
 * Stop the local dev plane. Teardown is reconstructed from the stamp (the
 * start-time Postgres handle does not survive a separate CLI invocation):
 * SIGTERM the orchestrator, stop Postgres by backend kind, then clear the
 * pidfile + stamp.
 */
export async function planeDown(): Promise<void> {
  const stamp = readStamp();
  const { pidfile, stampFile } = planePaths();
  if (stamp) {
    try {
      process.kill(stamp.orchestratorPid, 'SIGTERM');
    } catch {
      // Orchestrator already gone.
    }
    // Wait for the orchestrator to actually exit before returning. A bare
    // SIGTERM is asynchronous: the process keeps its listening socket during
    // graceful shutdown. Returning early lets a follow-on planeUp (e.g. the
    // detach/attach mode-switch reboot) satisfy its `/ready` probe against the
    // *outgoing* orchestrator and return before the new one has bound the port —
    // leaving a window where a subsequent `kici local status` sees no listener.
    await waitForProcessExit(stamp.orchestratorPid);
    await stopPlanePostgres(stamp.pgKind);
  }
  fs.rmSync(pidfile, { force: true });
  fs.rmSync(stampFile, { force: true });
}

/**
 * Poll until process `pid` has exited (SIGTERM already sent), escalating to
 * SIGKILL if it outlives the grace period, so the caller can rely on the
 * listening socket being released once this resolves. `process.kill(pid, 0)`
 * throws `ESRCH` once the process is gone.
 */
export async function waitForProcessExit(pid: number, graceMs = 10_000): Promise<void> {
  const deadline = Date.now() + graceMs;
  let killed = false;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — the process is gone (socket released).
    }
    if (!killed && Date.now() > deadline) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        return;
      }
      killed = true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Attach the local dev plane to the hosted Platform: mint an org-scoped
 * orchestrator key with the logged-in PAT, then (re)boot the plane hybrid
 * against the Platform relay. Registration with the Platform is implicit — the
 * hybrid orchestrator's PlatformClient sends `source.register` on WS auth.
 */
export async function attachPlane(args: {
  apiBase: string;
  pat: string;
  orgId: string;
}): Promise<PlaneStatus> {
  const platformWsUrl = derivePlatformWsUrl(args.apiBase);
  const minted = await mintOrchestratorKey({
    apiBase: args.apiBase,
    pat: args.pat,
    orgId: args.orgId,
    name: 'local dev plane',
  });
  return planeUp({
    attach: {
      platformWsUrl,
      platformToken: minted.key,
      platformApiBase: args.apiBase,
      orgId: args.orgId,
      keyId: minted.keyId,
    },
  });
}

/**
 * Detach the local dev plane: best-effort revoke the minted orchestrator key on
 * the Platform, clear the durable attachment + token, then reboot the plane
 * independent (offline). The revoke is non-fatal — a detach must succeed even
 * offline or with an expired PAT.
 */
export async function detachPlane(opts: { pat?: string } = {}): Promise<PlaneStatus> {
  const attachment = readAttachment();
  if (attachment && opts.pat) {
    await revokeOrchestratorKey({
      apiBase: attachment.platformApiBase,
      pat: opts.pat,
      orgId: attachment.orgId,
      keyId: attachment.keyId,
    }).catch(() => false);
  }
  clearAttachment();
  clearPlatformToken();
  await planeDown();
  return planeUp();
}
