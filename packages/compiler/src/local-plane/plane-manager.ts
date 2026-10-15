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
declare const KICI_BUILD_DATE: string;

/**
 * The CLI build's semver and build date, from the Rolldown-injected constants
 * (`scripts/build-ts.mjs`). The build date tells apart two builds at one semver;
 * the CLI is rebuilt whenever it or the orchestrator and agent it runs change.
 * Read per call, not cached, so unit tests can inject the constants via
 * `globalThis`. Falls back to `0.0.0` / `unknown` when run from source.
 */
export function currentBuildIdentity(): { version: string; buildDate: string } {
  return {
    version: typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.0',
    buildDate: typeof KICI_BUILD_DATE !== 'undefined' ? KICI_BUILD_DATE : 'unknown',
  };
}

/** Whether the plane runs offline (independent) or attached to the Platform (hybrid). */
export type PlaneMode = 'independent' | 'hybrid';

/**
 * Attachment record for a hybrid plane. The orchestrator token is NEVER stored
 * here — it lives in a sibling 0600 file so it can't land in a world-readable stamp.
 */
export interface PlaneAttachment {
  /** Orchestrator KICI_PLATFORM_URL — a ws(s)://…/ws relay URL. */
  platformWsUrl: string;
  /** HTTPS Platform API base (provenance/verify context, key revoke). */
  platformApiBase: string;
  orgId: string;
  /** Platform api_keys id of the minted orchestrator key, kept for revoke. */
  keyId: string;
}

/** On-disk record of the running plane, written on boot, read on status/down. */
export interface PlaneStamp {
  orchestratorPid: number;
  port: number;
  pgKind: 'embedded' | 'podman';
  kiciVersion: string;
  /** Build date of the CLI that booted this plane (see planeBuildIsStale). */
  buildDate: string;
  stampVersion: number;
  mode: PlaneMode;
}

export interface PlaneStatus {
  /** True only when the plane is serving — a live-but-unready plane is false. */
  running: boolean;
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
  mode: PlaneMode;
  /** Present iff mode === 'hybrid'. */
  attachment?: PlaneAttachment;
}

/** The persisted Platform orchestrator token (mode 0600), or null when the plane is independent. */
export function readPlatformToken(): string | null {
  try {
    const t = fs.readFileSync(planePaths().platformTokenFile, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

export function writePlatformToken(token: string): void {
  const { platformTokenFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(platformTokenFile, token, { mode: 0o600 });
}

export function clearPlatformToken(): void {
  fs.rmSync(planePaths().platformTokenFile, { force: true });
}

/**
 * The durable attachment record (survives `kici local down`), or null. This, not
 * the running stamp, is the source of truth for whether the plane is attached.
 */
export function readAttachment(): PlaneAttachment | null {
  try {
    return JSON.parse(fs.readFileSync(planePaths().attachmentFile, 'utf-8')) as PlaneAttachment;
  } catch {
    return null;
  }
}

export function writeAttachment(attachment: PlaneAttachment): void {
  const { attachmentFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(attachmentFile, JSON.stringify(attachment, null, 2));
}

export function clearAttachment(): void {
  fs.rmSync(planePaths().attachmentFile, { force: true });
}

/**
 * The plane's bootstrap admin token, generated (mode 0600) on first boot. It is
 * stable across CLI invocations so a running orchestrator keeps accepting the CLI.
 */
export function readOrCreateAdminToken(): string {
  const { adminTokenFile, root } = planePaths();
  try {
    const existing = fs.readFileSync(adminTokenFile, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable: generate below.
  }
  fs.mkdirSync(root, { recursive: true });
  const token = `kici-local-${randomBytes(24).toString('hex')}`;
  fs.writeFileSync(adminTokenFile, token, { mode: 0o600 });
  return token;
}

/** The plane's admin token, never generated (null when absent). */
export function planeAdminToken(): string | null {
  try {
    const t = fs.readFileSync(planePaths().adminTokenFile, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * The plane's master secret key: 64 hex chars (mode 0600), generated on first
 * boot and never derived from a sops secret. Stable across boots so DB-encrypted
 * material stays decryptable. It enables the orchestrator's secrets subsystem,
 * which gates its admin API surface.
 */
export function readOrCreateSecretKey(): string {
  const { secretKeyFile, root } = planePaths();
  try {
    const existing = fs.readFileSync(secretKeyFile, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable: generate below.
  }
  fs.mkdirSync(root, { recursive: true });
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyFile, key, { mode: 0o600 });
  return key;
}

export function devIdentityKeyFile(): string {
  return path.join(planePaths().devIdentityDir, 'identity.jwk');
}

/** Written by the plane orchestrator, not the CLI. */
export function devIdentityPublicJwkFile(): string {
  return path.join(planePaths().devIdentityDir, 'identity.pub.jwk');
}

/**
 * Ensure the dev-signed identity's EC P-256 private JWK (mode 0600) exists,
 * generated on first boot and NEVER derived from a sops secret or real key.
 * Stable across boots so a `kici local trust-root` export stays valid for
 * previously-minted tokens. The orchestrator writes the public JWK beside it.
 * Returns the path passed via KICI_DEV_IDENTITY_KEY_FILE.
 */
export function readOrCreateDevIdentity(): string {
  const keyFile = devIdentityKeyFile();
  try {
    const existing = fs.readFileSync(keyFile, 'utf-8').trim();
    if (existing) return keyFile;
  } catch {
    // Missing or unreadable: generate below.
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

export function clearStamp(): void {
  const { pidfile, stampFile } = planePaths();
  fs.rmSync(pidfile, { force: true });
  fs.rmSync(stampFile, { force: true });
}

/**
 * Whether the plane was booted by a different CLI build: another semver OR
 * another build date. False with no stamp, or when the current build date is
 * `unknown` (run from source), so a source-context `planeUp` never reboots a
 * healthy plane. A stamp from an older CLI lacks `buildDate`, so the first
 * upgrade reboots once.
 */
export function planeBuildIsStale(existing: PlaneStamp | null): boolean {
  if (!existing) return false;
  const { version, buildDate } = currentBuildIdentity();
  if (buildDate === 'unknown') return false;
  return existing.kiciVersion !== version || existing.buildDate !== buildDate;
}

function orchestratorUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function planeLogPath(): string {
  return planePaths().logFile;
}

/**
 * The plane's status, read from whatever holds the plane port. A live
 * orchestrator whose `/ready` fails reports `unready` with its failing checks,
 * not stopped: calling it stopped would hide a process that still owns the port.
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

/** See attachPlane. */
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
 * Tear the plane down before a fresh boot; throws when the port was not released.
 * Booting over a held port would fail later as a readiness timeout naming the
 * log, not the survivor, so the accurate reason is raised here.
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
 * Returns the running plane when it may be reused, or null when the caller must
 * boot fresh. An unstamped plane is reclaimed, not adopted: reuse would serve
 * `kici run --local` from an orchestrator of unknown build and scaler config,
 * the state the staleness check exists to prevent.
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
      // A stale build or a mode change reboots, KEEPING the Postgres data dir:
      // a build change is not a layout change, so the orchestrator's boot
      // migration (KICI_AUTO_MIGRATE=true) reconciles it.
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
 * Start or reuse the local dev plane. Idempotent: a healthy plane this config dir
 * stamped, **in the requested mode**, is returned as-is. Otherwise the port is
 * reclaimed if another KiCI plane holds it, and Postgres and the orchestrator
 * boot with a fresh stamp. `attach` boots hybrid against the Platform relay;
 * without it the plane boots independent with the dev-signed identity. Throws
 * when a non-KiCI process holds the port.
 */
export async function planeUp(opts: PlaneUpOptions = {}): Promise<PlaneStatus> {
  const { orchestrator: port } = planePorts();
  const existing = readStamp();
  const requestedMode: PlaneMode = opts.attach ? 'hybrid' : 'independent';

  // A stampVersion bump is a layout change that cannot migrate in place, so the
  // data dir is wiped; a kiciVersion-only change keeps it.
  if (existing && existing.stampVersion !== PLANE_STAMP_VERSION) {
    // Throws when the port is still held: wiping under a live Postgres destroys it.
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

  const { version: stampVersionSemver, buildDate: stampBuildDate } = currentBuildIdentity();
  const stamp: PlaneStamp = {
    orchestratorPid: orch.pid,
    port: orch.port,
    pgKind: pg.kind,
    kiciVersion: stampVersionSemver,
    buildDate: stampBuildDate,
    stampVersion: PLANE_STAMP_VERSION,
    mode: requestedMode,
  };
  // Stamped before the readiness wait, so a failed wait or a killed CLI still
  // leaves a record of the spawned pid.
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
 * Whether the stamped pid is still one of this build's plane orchestrators,
 * matched by its live command line against the entry this build launches.
 *
 * The stamp outlives its process (crash, `kill -9`, reboot), so a recycled pid
 * signalled blind would stop a stranger's program. This holds the stamp path to
 * the standard of `reclaimPlanePort`, which signals only a pid proven to hold
 * the port or to answer `/health` as a KiCI orchestrator.
 *
 * Returns false whenever identity cannot be established (unreadable command
 * line, unresolvable entry, another install): a missed signal leaves a process
 * running, a wrong one kills one.
 */
async function stampedPidIsOurOrchestrator(pid: number): Promise<boolean> {
  const cmdline = await processCommandLine(pid);
  if (!cmdline) return false;
  for (const resolveEntry of [resolveStandaloneEntry, resolveServerEntry]) {
    try {
      if (cmdline.includes(resolveEntry())) return true;
    } catch {
      // Unresolvable entry is no evidence: try the other.
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
 * Stop the local dev plane and confirm the port was released. Teardown works
 * from whatever holds the port, not only the stamp, since an unstamped plane is
 * still ours to stop. The stamp is cleared only once the port is verified free,
 * so a survivor never loses the pid that identifies it.
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

  // The reclaim signals only the port holder. A live stamped orchestrator that
  // does not hold the port (between spawn and bind, or listener lost) is
  // stopped here, or `down` succeeds over a process about to retake the port.
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
    // An unstamped plane has no record of its Postgres backend. Only the
    // embedded one is stopped: it is scoped to this plane's data dir and no-ops
    // without a postmaster.pid. The podman container has a host-global name not
    // scoped by KICI_CONFIG_DIR or port, so removing it could kill another
    // plane's database; the next boot replaces it (`podman run --replace`).
    await stopPlanePostgres('embedded');
  }
  clearStamp();
  return { stopped: true, port, holderPid: reclaim.killedPid };
}

/**
 * Mint an org-scoped orchestrator key with the logged-in PAT, then reboot the
 * plane hybrid. Registration is implicit: the orchestrator's PlatformClient
 * sends `source.register` on WS auth.
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
 * Revoke the minted key, clear the attachment and token, and reboot independent.
 * The revoke is best-effort: a detach must succeed offline or with an expired PAT.
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
