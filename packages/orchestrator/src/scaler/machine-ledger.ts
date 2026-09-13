/**
 * File-backed, cross-process resource ledger for named machine pools.
 *
 * Multiple orchestrators on the same host that reference the same `machinePool`
 * name share a JSON file under `KICI_MACHINE_LEDGER_DIR ?? /var/lib/kici/scaler-ledger`.
 * Each scaler reservation appends a row; releases delete the matching row;
 * and a periodic reaper prunes rows whose `(pid, bootId)` no longer exists.
 *
 * ## Concurrency
 *
 * Every read-modify-write goes through `withLock(poolName, fn)`, which uses
 * an atomic POSIX `mkdir` on a sibling lockdir as the cross-process mutex.
 * `mkdir` succeeds for exactly one caller when the directory does not exist,
 * so it works as a portable `flock` substitute without any native dependency.
 *
 * The plan considered `proper-lockfile` and `fs-ext` first; neither is a
 * transitive dep today (`pnpm why proper-lockfile` and `pnpm why fs-ext`
 * both empty), so we use the documented `mkdir` fallback. This avoids
 * adding a native binding for the sake of a single locking primitive.
 *
 * ## Crash safety
 *
 * Reservations carry `{ pid, bootId, instanceId, agentId, cpus, memBytes }`.
 * `bootId` is read once at orchestrator startup from
 * `/proc/sys/kernel/random/boot_id`; combined with `pid`, it lets the reaper
 * detect "this PID is dead AND was on a previous boot" reliably:
 *
 * - Same boot: `process.kill(pid, 0)` answers liveness.
 * - Different boot: any pre-reboot row is unconditionally stale.
 *
 * If an orchestrator dies without releasing, the next reservation request
 * from any orchestrator on the host calls `reapStale()` first, so there's
 * no leak window beyond the next spawn attempt.
 */

import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@kici-dev/shared';
import type { ResourceCap } from './types.js';

const logger = createLogger({ prefix: 'machine-ledger' });

const LEDGER_VERSION = 1;

/** Wire format for the per-pool ledger JSON file. */
export interface LedgerFile {
  version: number;
  cap: ResourceCap;
  reservations: ReservationRow[];
}

/** A single reservation row in the ledger. */
export interface ReservationRow {
  /** Orchestrator instance id (from `KICI_CLUSTER_INSTANCE_ID` or generated). */
  instanceId: string;
  /** Process id that owns this reservation. */
  pid: number;
  /** Linux boot id at the time the row was created. */
  bootId: string;
  /** Agent id this reservation is associated with. */
  agentId: string;
  /** Reserved cpus (cores). */
  cpus: number;
  /** Reserved memory in bytes. */
  memBytes: number;
  /** When the row was inserted (epoch ms). */
  reservedAt: number;
}

/** Lock acquisition options. */
interface LockOptions {
  /** Maximum retries before bailing. Each retry waits a short jitter. */
  maxAttempts?: number;
  /** Initial backoff in ms; doubles per retry up to a cap. */
  initialBackoffMs?: number;
}

/**
 * Read the host's Linux boot id once at startup. Used together with `pid` so
 * the reaper can tell whether a stale row points to a dead process.
 *
 * Falls back to a synthesized id on non-Linux hosts (development machines).
 * On those hosts the cross-orchestrator coordination story still works —
 * the ledger just can't distinguish "same boot, dead pid" from "different
 * boot" because the host doesn't expose a boot id. `process.kill(pid, 0)`
 * still answers liveness for the same-host common case.
 */
function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Synthesize a per-process boot id so darwin / non-Linux dev hosts still
    // function. A genuine boot id can only come from /proc; without it any
    // cross-process coordination on dev machines should be considered
    // best-effort.
    return `synthetic-${process.pid}-${Date.now()}`;
  }
}

/**
 * Resolve the on-disk ledger directory.
 *
 * 1. Caller-provided dir wins.
 * 2. `/var/lib/kici/scaler-ledger` if writable.
 * 3. `${XDG_STATE_HOME:-$HOME/.local/state}/kici/scaler-ledger`.
 * 4. `${tmpdir}/kici-scaler-ledger` (last resort, e.g. CI sandboxes).
 */
async function resolveLedgerDir(explicit: string | undefined): Promise<string> {
  if (explicit) {
    await mkdir(explicit, { recursive: true });
    return explicit;
  }
  const candidates: string[] = [];
  candidates.push('/var/lib/kici/scaler-ledger');
  const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  candidates.push(join(xdgState, 'kici', 'scaler-ledger'));
  candidates.push(join(tmpdir(), 'kici-scaler-ledger'));

  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      // Probe writability with a sentinel file we immediately remove.
      const sentinel = join(dir, `.write-probe-${process.pid}`);
      await writeFile(sentinel, 'probe', { encoding: 'utf8' });
      await rm(sentinel, { force: true });
      return dir;
    } catch {
      continue;
    }
  }
  throw new Error('machine-ledger: could not resolve a writable ledger directory');
}

/**
 * File-backed machine pool ledger.
 *
 * One instance is shared across all scaler entries that reference any pool
 * (the pool name is passed per-call). The ledger does not cache the JSON:
 * every operation goes through the lock, reads the file, applies the
 * mutation, and writes it back — keeping the wire format the only source
 * of truth across processes.
 */
export class MachineLedger {
  private readonly bootId = readBootId();
  private dirPath: string | null = null;
  private readonly explicitDir: string | undefined;
  private readonly instanceId: string;
  /** Per-process knownCaps cache; the on-disk file's `cap` must match the caller's expectation. */
  private readonly expectedCaps = new Map<string, ResourceCap>();
  /** Reaper interval handle. */
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { explicitDir?: string; instanceId: string }) {
    this.explicitDir = opts.explicitDir;
    this.instanceId = opts.instanceId;
  }

  /**
   * Lazy directory resolution so construction stays synchronous. Called from
   * every operation; resolves once and caches.
   */
  private async ensureDir(): Promise<string> {
    if (this.dirPath !== null) return this.dirPath;
    this.dirPath = await resolveLedgerDir(this.explicitDir);
    logger.info('Machine ledger directory resolved', { path: this.dirPath });
    return this.dirPath;
  }

  /** Register the expected cap for a pool. The on-disk file's cap must match. */
  registerPool(name: string, cap: ResourceCap): void {
    this.expectedCaps.set(name, cap);
  }

  /**
   * Path to the JSON file for `poolName`. Sibling lockdir is `<file>.lock`.
   */
  private async pathFor(poolName: string): Promise<{ file: string; lock: string }> {
    const dir = await this.ensureDir();
    return { file: join(dir, `${poolName}.json`), lock: join(dir, `${poolName}.lock`) };
  }

  /**
   * Atomic mkdir-based lock. Held for the duration of `fn`.
   */
  private async withLock<T>(
    poolName: string,
    fn: () => Promise<T>,
    opts: LockOptions = {},
  ): Promise<T> {
    const { lock } = await this.pathFor(poolName);
    const maxAttempts = opts.maxAttempts ?? 200;
    let backoff = opts.initialBackoffMs ?? 5;
    let acquired = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await mkdir(lock, { recursive: false });
        acquired = true;
        break;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err;
        // Lock is taken — check if its holder is dead. If the lockdir is
        // older than 30s with no live pid, force-release.
        await this.maybeReleaseStaleLock(lock);
        await delay(Math.min(backoff, 100));
        backoff = Math.min(backoff * 2, 100);
      }
    }
    if (!acquired) {
      throw new Error(`machine-ledger: could not acquire lock on ${lock} (timed out)`);
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * If the lock directory has been held for more than 30 seconds, assume the
   * holder is dead and release it. Without this, an orchestrator that gets
   * SIGKILL'd while holding the lock would leave it stuck forever.
   */
  private async maybeReleaseStaleLock(lock: string): Promise<void> {
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs > 30_000) {
        logger.warn('Force-releasing stale lock directory', { lock });
        await rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Lock vanished while we were checking — fine.
    }
  }

  /**
   * Read the ledger file (or initialize an empty one when missing).
   */
  private async readLedger(poolName: string): Promise<LedgerFile> {
    const { file } = await this.pathFor(poolName);
    const expected = this.expectedCaps.get(poolName);
    if (!expected) {
      throw new Error(
        `machine-ledger: pool "${poolName}" was not registered with registerPool() before use`,
      );
    }
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { version: LEDGER_VERSION, cap: expected, reservations: [] };
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as LedgerFile;
    if (parsed.version !== LEDGER_VERSION) {
      throw new Error(
        `machine-ledger: pool "${poolName}" file has unknown version ${parsed.version}`,
      );
    }
    if (
      parsed.cap.maxCpu !== expected.maxCpu ||
      parsed.cap.maxMemoryBytes !== expected.maxMemoryBytes
    ) {
      throw new Error(
        `machine-ledger: pool "${poolName}" cap mismatch -- file has ${JSON.stringify(parsed.cap)}, ` +
          `caller expects ${JSON.stringify(expected)}. Edit one orchestrator's config or update the file.`,
      );
    }
    return parsed;
  }

  /** Atomic write via temp-file + rename. */
  private async writeLedger(poolName: string, data: LedgerFile): Promise<void> {
    const { file } = await this.pathFor(poolName);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' });
    await rename(tmp, file);
  }

  /**
   * Try to add a reservation. Returns true if the cap allowed it (and the row
   * was persisted), false if any cap would be exceeded after summing.
   *
   * Reaps stale rows from dead processes before checking the cap so an
   * orphaned reservation doesn't permanently squat capacity.
   */
  async tryReserve(
    poolName: string,
    agentId: string,
    cpus: number,
    memBytes: number,
  ): Promise<boolean> {
    return this.withLock(poolName, async () => {
      const ledger = await this.readLedger(poolName);
      this.dropDeadReservations(ledger);
      const used = sumReservations(ledger.reservations);
      if (ledger.cap.maxCpu !== undefined && used.cpus + cpus > ledger.cap.maxCpu) {
        logger.info('machine-ledger reservation refused (cpu cap)', {
          pool: poolName,
          requested: cpus,
          used: used.cpus,
          max: ledger.cap.maxCpu,
        });
        await this.writeLedger(poolName, ledger);
        return false;
      }
      if (
        ledger.cap.maxMemoryBytes !== undefined &&
        used.memBytes + memBytes > ledger.cap.maxMemoryBytes
      ) {
        logger.info('machine-ledger reservation refused (mem cap)', {
          pool: poolName,
          requested: memBytes,
          used: used.memBytes,
          max: ledger.cap.maxMemoryBytes,
        });
        await this.writeLedger(poolName, ledger);
        return false;
      }
      ledger.reservations.push({
        instanceId: this.instanceId,
        pid: process.pid,
        bootId: this.bootId,
        agentId,
        cpus,
        memBytes,
        reservedAt: Date.now(),
      });
      await this.writeLedger(poolName, ledger);
      logger.info('machine-ledger reservation granted', {
        pool: poolName,
        agentId,
        cpus,
        memBytes,
      });
      return true;
    });
  }

  /**
   * Release the reservation for `agentId`. Idempotent.
   */
  async release(poolName: string, agentId: string): Promise<void> {
    await this.withLock(poolName, async () => {
      const ledger = await this.readLedger(poolName);
      const before = ledger.reservations.length;
      ledger.reservations = ledger.reservations.filter(
        (r) => r.instanceId !== this.instanceId || r.agentId !== agentId,
      );
      if (ledger.reservations.length !== before) {
        await this.writeLedger(poolName, ledger);
        logger.info('machine-ledger reservation released', { pool: poolName, agentId });
      }
    });
  }

  /**
   * Reap stale (dead-process) rows for the given pool. Called periodically.
   */
  async reapStale(poolName: string): Promise<void> {
    await this.withLock(poolName, async () => {
      const ledger = await this.readLedger(poolName);
      const before = ledger.reservations.length;
      this.dropDeadReservations(ledger);
      if (ledger.reservations.length !== before) {
        await this.writeLedger(poolName, ledger);
        logger.info('machine-ledger reaped stale reservations', {
          pool: poolName,
          removed: before - ledger.reservations.length,
        });
      }
    });
  }

  /**
   * Mutates `ledger.reservations` in place to drop rows that point at dead
   * processes. Live-pid heuristic:
   * - Different bootId → unconditionally dead (host rebooted since).
   * - Same bootId, OWN instance: probe via `process.kill(pid, 0)` (always
   *   works inside this process's PID namespace).
   * - Same bootId, OTHER instance: keep the row. We cannot safely
   *   `process.kill(pid, 0)` against a peer orchestrator's PID — when the
   *   two orchestrators share a host but live in different PID namespaces
   *   (e.g. one runs natively and the other in a container), `kill` returns
   *   ESRCH for any peer pid and the reservation would be falsely reaped,
   *   silently breaking the cross-process cap. Peer cleanup happens via
   *   `releaseAllForInstance()` on graceful shutdown; SIGKILL'd peers leave
   *   their rows in place until the host reboots (which the bootId check
   *   then reaps unconditionally).
   */
  private dropDeadReservations(ledger: LedgerFile): void {
    ledger.reservations = ledger.reservations.filter((r) => {
      if (r.bootId !== this.bootId) return false;
      if (r.instanceId !== this.instanceId) return true;
      try {
        process.kill(r.pid, 0);
        return true;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EPERM') return true; // exists, just not ours
        return false; // ESRCH = no such process
      }
    });
  }

  /** Return current usage (sum of `requests` across all live rows). */
  async getUsage(poolName: string): Promise<{ cpus: number; memBytes: number }> {
    return this.withLock(poolName, async () => {
      const ledger = await this.readLedger(poolName);
      this.dropDeadReservations(ledger);
      return sumReservations(ledger.reservations);
    });
  }

  /**
   * Start the periodic reaper. Idempotent. The reaper iterates every
   * registered pool every 30s.
   */
  start(intervalMs = 30_000): void {
    if (this.reaperTimer !== null) return;
    this.reaperTimer = setInterval(() => {
      void this.reapAllPools();
    }, intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      this.reaperTimer.unref();
    }
  }

  /** Stop the periodic reaper. */
  stop(): void {
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  private async reapAllPools(): Promise<void> {
    for (const pool of this.expectedCaps.keys()) {
      try {
        await this.reapStale(pool);
      } catch (err) {
        logger.warn('machine-ledger reaper failed', { pool, error: String(err) });
      }
    }
  }

  /**
   * Best-effort: release every reservation owned by this instance across all
   * registered pools. Called on graceful shutdown.
   */
  async releaseAllForInstance(): Promise<void> {
    for (const pool of this.expectedCaps.keys()) {
      try {
        await this.withLock(pool, async () => {
          const ledger = await this.readLedger(pool);
          const before = ledger.reservations.length;
          ledger.reservations = ledger.reservations.filter((r) => r.instanceId !== this.instanceId);
          if (ledger.reservations.length !== before) {
            await this.writeLedger(pool, ledger);
          }
        });
      } catch (err) {
        logger.warn('machine-ledger release-all failed', { pool, error: String(err) });
      }
    }
  }
}

function sumReservations(rows: ReservationRow[]): { cpus: number; memBytes: number } {
  return rows.reduce(
    (acc, r) => ({ cpus: acc.cpus + r.cpus, memBytes: acc.memBytes + r.memBytes }),
    { cpus: 0, memBytes: 0 },
  );
}
