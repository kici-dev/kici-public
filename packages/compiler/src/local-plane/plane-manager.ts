import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { planePaths, planePorts, PLANE_STAMP_VERSION } from './paths.js';
import { startPlanePostgres, stopPlanePostgres } from './postgres.js';
import {
  spawnOrchestratorProcess,
  awaitOrchestratorReady,
  resolveStandaloneEntry,
  resolveServerEntry,
} from './orchestrator-process.js';
import { terminatePid, isPortFree, processCommandLine } from './port-holder.js';
import {
  classifyPlane,
  reclaimPlanePort,
  classificationPid,
  planeStateOf,
  type PlaneState,
} from './plane-liveness.js';
import { writeScalerConfig } from './scaler-config.js';
import {
  derivePlatformWsUrl,
  mintOrchestratorKey,
  revokeOrchestratorKey,
} from './platform-attach.js';

declare const KICI_VERSION: string;
declare const KICI_BUILD_COMMIT: string;

/**
 * The current CLI build's identity — semver plus git build commit — read at
 * call time from the Rolldown-injected build constants (`scripts/build-ts.mjs`).
 * Read on each call rather than captured in a module const so unit tests can
 * inject the constants via `globalThis`. Falls back to `0.0.0` / `unknown` when
 * running from source (unbuilt tree / vitest), where the defines are absent.
 */
export function currentBuildIdentity(): { version: string; buildCommit: string } {
  return {
    version: typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.0',
    buildCommit: typeof KICI_BUILD_COMMIT !== 'undefined' ? KICI_BUILD_COMMIT : 'unknown',
  };
}

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
  /** Git build commit of the CLI that booted this plane (see planeBuildIsStale). */
  buildCommit: string;
  stampVersion: number;
  /** Offline (independent) vs attached (hybrid). Absent (legacy) reads as independent. */
  mode?: PlaneMode;
}

export interface PlaneStatus {
  /** True only when the plane is serving — a live-but-unready plane is false. */
  running: boolean;
  /** Liveness of the plane port: stopped, serving, live-but-not-serving, or held by someone else. */
  state: PlaneState;
  /** Failing `/ready` checks, when the plane is live but not serving. */
  checks?: Record<string, boolean>;
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

/** Remove the plane's on-disk record (pidfile + stamp). */
export function clearStamp(): void {
  const { pidfile, stampFile } = planePaths();
  fs.rmSync(pidfile, { force: true });
  fs.rmSync(stampFile, { force: true });
}

/**
 * Whether a running plane described by `existing` was booted from a different
 * CLI build than the current one — a semver bump OR a git-commit change (the
 * latter covers intermediate staging/E2E commits that share a semver). Returns
 * false when there is no stamp, or when the current build has no concrete
 * identity (`buildCommit === 'unknown'`, i.e. running from source / a test),
 * so a source-context `planeUp` never reboots a healthy plane spuriously. An
 * old stamp with no `buildCommit` field reads as `undefined` and therefore
 * triggers a one-time reboot on the first upgrade past this feature.
 */
export function planeBuildIsStale(existing: PlaneStamp | null): boolean {
  if (!existing) return false;
  const { version, buildCommit } = currentBuildIdentity();
  if (buildCommit === 'unknown') return false;
  return existing.kiciVersion !== version || existing.buildCommit !== buildCommit;
}

function orchestratorUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Absolute path of the plane orchestrator's log file. */
export function planeLogPath(): string {
  return planePaths().logFile;
}

/**
 * Read the plane's current status from whatever holds the plane port.
 *
 * `running` means "serving": a live orchestrator whose `/ready` fails is
 * reported as `unready`, with the failing checks, rather than as stopped —
 * inferring "not running" from an unready probe hides a process that still owns
 * the port.
 */
export async function planeStatus(): Promise<PlaneStatus> {
  const stamp = readStamp();
  const port = stamp?.port ?? planePorts().orchestrator;
  const classification = await classifyPlane(port, stamp);
  const mode = stamp?.mode ?? 'independent';
  const attachment = readAttachment() ?? undefined;

  if (classification.kind === 'free') {
    return { running: false, state: 'stopped', mode, attachment };
  }

  if (classification.kind === 'ours-ready') {
    return {
      running: true,
      state: 'ready',
      pid: classification.pid,
      port,
      pgKind: stamp?.pgKind,
      stampVersion: stamp?.stampVersion,
      url: orchestratorUrl(port),
      adminToken: planeAdminToken() ?? undefined,
      mode,
      attachment,
    };
  }

  return {
    running: false,
    state: planeStateOf(classification),
    pid: classificationPid(classification) ?? undefined,
    port,
    pgKind: stamp?.pgKind,
    url: orchestratorUrl(port),
    checks: classification.kind === 'ours-unready' ? classification.checks : undefined,
    mode,
    attachment,
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
 * Tear the plane down ahead of a fresh boot, refusing to continue when the port
 * was not released.
 *
 * Booting over a still-held port only re-fails later, as a readiness timeout
 * that names the log instead of the survivor — so the teardown's own reason (the
 * pid still holding the port) is raised here, while it is still the accurate
 * one.
 */
async function tearDownForBoot(): Promise<void> {
  const result = await planeDown();
  if (result.stopped) return;
  const holder = result.holderPid === undefined ? '' : ` (pid ${result.holderPid})`;
  throw new Error(
    result.reason ??
      `port ${result.port} is still held after stopping the local dev plane${holder}`,
  );
}

/**
 * Ensure the plane port is either reusable or vacant before a boot.
 *
 * Returns the running plane when it may be reused as-is, or null when the caller
 * must boot fresh. A plane no stamp accounts for is reclaimed rather than
 * adopted: reuse would serve `kici run --local` from an orchestrator of unknown
 * build, with an unknown scaler configuration, which is exactly the state a
 * stamped plane's staleness check exists to prevent.
 */
async function prepareForBoot(
  port: number,
  existing: PlaneStamp | null,
  requestedMode: PlaneMode,
): Promise<PlaneStatus | null> {
  const classification = await classifyPlane(port, existing);
  switch (classification.kind) {
    case 'free':
      return null;

    case 'foreign-unknown': {
      const reclaim = await reclaimPlanePort(port, classification);
      throw new Error(reclaim.error ?? `port ${port} is held by an unrecognised process`);
    }

    case 'foreign-kici': {
      const reclaim = await reclaimPlanePort(port, classification);
      if (!reclaim.freed) throw new Error(reclaim.error ?? `could not reclaim port ${port}`);
      clearStamp();
      return null;
    }

    case 'ours-unready':
      await tearDownForBoot();
      return null;

    case 'ours-ready': {
      // A running plane booted from a different CLI build (semver OR git build
      // commit) is stale — reuse would serve `kici run --local` at the old
      // version. Reboot from the current dist, KEEPING the Postgres data dir:
      // an identity change is not an on-disk layout change, so the
      // orchestrator's boot migration (KICI_AUTO_MIGRATE=true) reconciles it.
      // A mode change (independent↔hybrid) forces the same reboot.
      const modeChanged = (existing?.mode ?? 'independent') !== requestedMode;
      if (planeBuildIsStale(existing) || modeChanged) {
        await tearDownForBoot();
        return null;
      }
      return {
        running: true,
        state: 'ready',
        pid: classification.pid,
        port,
        pgKind: existing?.pgKind,
        stampVersion: existing?.stampVersion,
        url: orchestratorUrl(port),
        adminToken: planeAdminToken() ?? undefined,
        mode: existing?.mode ?? 'independent',
        attachment: readAttachment() ?? undefined,
      };
    }
  }
}

/**
 * Start (or reuse) the local dev plane. Idempotent: a healthy running plane this
 * config dir stamped, **whose stamped mode matches the requested mode**, is
 * returned as-is. Otherwise the port is reclaimed if it is another KiCI plane,
 * and Postgres + the orchestrator are booted with a fresh stamp + pidfile. When
 * `attach` is present the orchestrator boots hybrid against the Platform relay;
 * otherwise it boots independent with the dev-signed identity. Throws when the
 * port is held by a process that is not a KiCI plane orchestrator.
 */
export async function planeUp(opts: PlaneUpOptions = {}): Promise<PlaneStatus> {
  const { orchestrator: port } = planePorts();
  const existing = readStamp();
  const requestedMode: PlaneMode = opts.attach ? 'hybrid' : 'independent';

  // An incompatible on-disk layout (stampVersion bump) cannot be migrated in
  // place, so the plane is torn down and the data dir wiped before a fresh
  // boot. A kiciVersion-only change keeps the data and relies on the
  // orchestrator's boot migration (KICI_AUTO_MIGRATE=true).
  if (existing && existing.stampVersion !== PLANE_STAMP_VERSION) {
    // Throws when the port was not released — wiping the data dir under a plane
    // that is still running would destroy a live Postgres' storage.
    await tearDownForBoot();
    fs.rmSync(planePaths().pgData, { recursive: true, force: true });
  } else {
    const reusable = await prepareForBoot(port, existing, requestedMode);
    if (reusable) return reusable;
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
    orch = spawnOrchestratorProcess(pg.url, {
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
    orch = spawnOrchestratorProcess(pg.url, {
      adminToken,
      secretKey,
      scalerConfigFile,
      devIdentityKeyFile: devIdentityKey,
    });
  }

  const { version: stampVersionSemver, buildCommit: stampBuildCommit } = currentBuildIdentity();
  const stamp: PlaneStamp = {
    orchestratorPid: orch.pid,
    port: orch.port,
    pgKind: pg.kind,
    kiciVersion: stampVersionSemver,
    buildCommit: stampBuildCommit,
    stampVersion: PLANE_STAMP_VERSION,
    mode: requestedMode,
  };
  // Stamped before the readiness wait: a wait that fails, or a CLI killed
  // during it, must still leave a record of the pid we spawned.
  writeStamp(stamp);

  try {
    await awaitOrchestratorReady(orch.port);
  } catch {
    await terminatePid(orch.pid);
    // Keep the stamp when the port is still held — the pid is the only handle a
    // later `kici local down` has on the survivor.
    if (await isPortFree(orch.port)) clearStamp();
    throw new Error(`local orchestrator did not become ready — see ${planeLogPath()}`);
  }

  return {
    running: true,
    state: 'ready',
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
 * Whether the stamped pid is still one of this build's plane orchestrators.
 *
 * The stamp outlives the process it names — a crash, a `kill -9`, or a reboot
 * all leave it behind — so once the operating system recycles that pid onto an
 * unrelated process, signalling it blind would stop a stranger's program. Every
 * other signal path in the plane is identity-verified (`reclaimPlanePort` only
 * ever signals a pid confirmed to hold the port or to answer `/health` as a KiCI
 * orchestrator); this keeps the stamp-driven path to the same standard by
 * matching the live command line against the entry this build would launch.
 *
 * Returns false whenever identity cannot be established — an unreadable command
 * line, an unresolvable entry, or a plane launched from a different install.
 * That is deliberate: not signalling leaves a process running, while signalling
 * the wrong pid kills one.
 */
async function stampedPidIsOurOrchestrator(pid: number): Promise<boolean> {
  const cmdline = await processCommandLine(pid);
  if (!cmdline) return false;
  for (const resolveEntry of [resolveStandaloneEntry, resolveServerEntry]) {
    try {
      if (cmdline.includes(resolveEntry())) return true;
    } catch {
      // Entry not resolvable from here — no evidence, try the other.
    }
  }
  return false;
}

/** Outcome of a teardown attempt. `stopped` is true only when the port is verified free. */
export interface PlaneDownResult {
  stopped: boolean;
  port: number;
  holderPid?: number;
  reason?: string;
}

/**
 * Stop the local dev plane and confirm the port was released.
 *
 * Teardown is reconstructed from whatever holds the port, not only from the
 * stamp: a plane this config dir never stamped still occupies the port and is
 * still ours to stop. The pidfile and stamp are cleared only once the port is
 * verified free, so a survivor never loses the pid that identifies it.
 */
export async function planeDown(): Promise<PlaneDownResult> {
  const stamp = readStamp();
  const port = stamp?.port ?? planePorts().orchestrator;
  const classification = await classifyPlane(port, stamp);
  const reclaim = await reclaimPlanePort(port, classification);

  if (!reclaim.freed) {
    return {
      stopped: false,
      port,
      holderPid: reclaim.killedPid ?? classificationPid(classification) ?? undefined,
      reason: reclaim.error,
    };
  }

  // A stamped orchestrator that is alive but is NOT the port holder — a boot
  // still between spawn and bind, or one that lost its listener — was never
  // touched by the reclaim above, because the reclaim only ever signals the
  // holder. Stop it here, or `down` reports success over a process that is
  // about to take the port back.
  if (
    stamp &&
    stamp.orchestratorPid !== reclaim.killedPid &&
    (await stampedPidIsOurOrchestrator(stamp.orchestratorPid))
  ) {
    await terminatePid(stamp.orchestratorPid);
    if (!(await isPortFree(port))) {
      return {
        stopped: false,
        port,
        holderPid: stamp.orchestratorPid,
        reason: `port ${port} is still held after stopping pid ${stamp.orchestratorPid}`,
      };
    }
  }

  if (stamp) {
    await stopPlanePostgres(stamp.pgKind);
  } else if (classification.kind !== 'free') {
    // A plane we never stamped leaves no record of its Postgres backend. Only
    // the embedded backend is stopped: it is scoped to this plane's own data
    // dir, and returns early when there is no postmaster.pid there. The podman
    // fallback container carries a fixed host-global name that is not scoped by
    // KICI_CONFIG_DIR or port, so removing it here could tear down a different
    // plane's database — a survivor is preferable to that, and the next boot
    // replaces the container anyway (`podman run --replace`).
    await stopPlanePostgres('embedded');
  }
  clearStamp();
  return { stopped: true, port, holderPid: reclaim.killedPid };
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
