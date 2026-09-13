/**
 * One answer to "is a local dev plane running", shared by up, down, and status.
 *
 * Ownership is decided by pid identity — the process actually holding the port
 * versus the pid the stamp names — not by whether a stamp file exists. That is
 * what keeps the three commands consistent: a plane nobody stamped is foreign to
 * all of them, rather than invisible to two and adoptable by the third.
 *
 * Every external effect arrives through `PlaneProbes`, so the policy here is
 * exercised without a subprocess or a socket.
 */
import { isPortFree, findPortHolderPid, terminatePid, waitForPortFree } from './port-holder.js';

/** The stamp fields classification needs. Structural, to avoid an import cycle with plane-manager. */
export interface StampIdentity {
  orchestratorPid: number;
  port: number;
}

/** The `/health` fields that identify a KiCI orchestrator. */
export interface KiciHealth {
  uptime: number;
  version?: string;
  buildCommit?: string;
}

export type PlaneState = 'stopped' | 'ready' | 'unready' | 'foreign-kici' | 'foreign-unknown';

export type PlaneClassification =
  | { kind: 'free' }
  | { kind: 'ours-ready'; pid: number }
  | { kind: 'ours-unready'; pid: number; checks: Record<string, boolean> }
  | { kind: 'foreign-kici'; pid: number | null; health: KiciHealth }
  | { kind: 'foreign-unknown'; pid: number | null };

export interface PlaneProbes {
  isPortFree(port: number): Promise<boolean>;
  findPortHolderPid(port: number): Promise<number | null>;
  /** The parsed `/health` body, or null when it did not answer in time. */
  fetchHealth(port: number): Promise<unknown>;
  fetchReady(port: number): Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  isPidAlive(pid: number): boolean;
}

export interface ReclaimResult {
  freed: boolean;
  killedPid?: number;
  error?: string;
}

/**
 * Cap on each loopback probe. The holder these probes exist to diagnose is
 * frequently wedged, and a socket that accepts a connection but never answers
 * would otherwise hang the CLI for the HTTP client's own multi-minute default —
 * turning `kici local status` into the hang it is meant to explain. A holder
 * that cannot answer loopback within this window is treated as not answering.
 */
const PROBE_TIMEOUT_MS = 2_000;

const defaultProbes: PlaneProbes = {
  isPortFree,
  findPortHolderPid,
  async fetchHealth(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!r.ok) return null;
      return (await r.json()) as unknown;
    } catch {
      return null;
    }
  },
  async fetchReady(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = (await r.json().catch(() => ({}))) as { checks?: Record<string, boolean> };
      return { ok: r.status === 200, checks: body.checks ?? {} };
    } catch {
      return { ok: false, checks: {} };
    }
  },
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Whether a `/health` body came from a KiCI orchestrator. The build-fingerprint
 * fields are the discriminator: an `ok` status alone is far too common to
 * justify signalling the process that produced it.
 */
export function isKiciOrchestratorHealth(body: unknown): body is KiciHealth {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.status === 'ok' &&
    typeof b.uptime === 'number' &&
    'sdkBundleHash' in b &&
    'engineBundleHash' in b
  );
}

/** The state label a classification reports to the operator. */
export function planeStateOf(c: PlaneClassification): PlaneState {
  switch (c.kind) {
    case 'free':
      return 'stopped';
    case 'ours-ready':
      return 'ready';
    case 'ours-unready':
      return 'unready';
    case 'foreign-kici':
      return 'foreign-kici';
    case 'foreign-unknown':
      return 'foreign-unknown';
  }
}

/** The holder pid a classification carries, when it has one. */
export function classificationPid(c: PlaneClassification): number | null {
  return 'pid' in c ? c.pid : null;
}

/**
 * Decide what, if anything, is holding the plane port and whether it is ours.
 *
 * `stamp` is the on-disk record of the plane this config dir booted; a null
 * stamp means nothing here booted the holder, so any live holder is foreign.
 */
export async function classifyPlane(
  port: number,
  stamp: StampIdentity | null,
  probes: Partial<PlaneProbes> = {},
): Promise<PlaneClassification> {
  const p: PlaneProbes = { ...defaultProbes, ...probes };
  if (await p.isPortFree(port)) return { kind: 'free' };

  const holderPid = await p.findPortHolderPid(port);
  // When discovery cannot name the holder, fall back to the stamp: the port is
  // occupied and a stamped plane whose pid is still alive is the only candidate
  // we know of. When discovery does name one, pid identity is authoritative.
  //
  // The fallback assumes the stamped pid was not recycled onto an unrelated
  // process while some third party took the port — the one case where a stop
  // would signal a pid that is not the holder. It needs both `ss` and `lsof` to
  // be missing or failing, which is why identity is not re-derived from
  // `/health` here: that would trade a rare miss for reporting every plane whose
  // orchestrator is too wedged to answer as foreign.
  const ours =
    holderPid !== null
      ? stamp !== null && holderPid === stamp.orchestratorPid
      : stamp !== null && p.isPidAlive(stamp.orchestratorPid);

  if (ours && stamp !== null) {
    const ready = await p.fetchReady(port);
    return ready.ok
      ? { kind: 'ours-ready', pid: stamp.orchestratorPid }
      : { kind: 'ours-unready', pid: stamp.orchestratorPid, checks: ready.checks };
  }

  const health = await p.fetchHealth(port);
  return isKiciOrchestratorHealth(health)
    ? { kind: 'foreign-kici', pid: holderPid, health }
    : { kind: 'foreign-unknown', pid: holderPid };
}

/**
 * Free the plane port, if it is ours or another KiCI plane orchestrator. A
 * holder that does not identify as one is reported and left strictly alone.
 */
export async function reclaimPlanePort(
  port: number,
  c: PlaneClassification,
): Promise<ReclaimResult> {
  if (c.kind === 'free') return { freed: true };
  if (c.kind === 'foreign-unknown') {
    const who = c.pid === null ? '' : ` (pid ${c.pid})`;
    return {
      freed: false,
      error: `port ${port} is held by a process that is not a KiCI plane orchestrator${who} — refusing to stop it`,
    };
  }
  const pid = classificationPid(c);
  if (pid === null) {
    return {
      freed: false,
      error: `port ${port} is held by a KiCI plane orchestrator whose pid could not be determined`,
    };
  }
  await terminatePid(pid);
  const freed = await waitForPortFree(port);
  return freed
    ? { freed: true, killedPid: pid }
    : {
        freed: false,
        killedPid: pid,
        error: `port ${port} is still held after stopping pid ${pid}`,
      };
}
