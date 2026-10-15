/**
 * File-backed, cross-process resource ledger for named machine pools.
 *
 * Orchestrators on one host that name the same `machinePool` share a JSON file
 * under `KICI_MACHINE_LEDGER_DIR ?? /var/lib/kici/scaler-ledger`. A reservation
 * appends a row, a release deletes it, and a periodic reaper prunes rows whose
 * `(pid, bootId)` no longer exists.
 *
 * ## Concurrency
 *
 * Every read-modify-write runs under `withLock`: an atomic POSIX `mkdir` on a
 * sibling lockdir succeeds for exactly one caller, a portable `flock`
 * substitute. `proper-lockfile` / `fs-ext` are rejected to avoid a native
 * binding for one primitive.
 *
 * ## Crash safety
 *
 * `bootId` is read once at startup from `/proc/sys/kernel/random/boot_id`; with
 * `pid` it lets the reaper tell a dead process:
 *
 * - Same boot: `process.kill(pid, 0)` answers liveness.
 * - Different boot: any pre-reboot row is unconditionally stale.
 *
 * Each reservation reaps first, so a crashed orchestrator's rows leak no longer
 * than the next spawn attempt.
 */

import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@kici-dev/shared';
import type { ResourceCap } from './types.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'machine-ledger' });

const LEDGER_VERSION = 1;

/** Wire format for the per-pool ledger JSON file. */
export interface LedgerFile {
  version: number;
  cap: ResourceCap;
  reservations: ReservationRow[];
}

export interface ReservationRow {
  /** From `KICI_CLUSTER_INSTANCE_ID`, or generated. */
  instanceId: string;
  pid: number;
  /** Linux boot id when the row was created. */
  bootId: string;
  agentId: string;
  /** Cores. */
  cpus: number;
  memBytes: number;
  /** Epoch ms. */
  reservedAt: number;
}

interface LockOptions {
  maxAttempts?: number;
  /** Initial backoff in ms; doubles per retry up to a cap. */
  initialBackoffMs?: number;
}

/**
 * Read the host's Linux boot id once at startup.
 *
 * Non-Linux dev hosts get a synthesized id, so the ledger cannot tell "same
 * boot, dead pid" from "different boot" there and cross-process coordination is
 * best-effort; `process.kill(pid, 0)` still answers same-host liveness.
 */
function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
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
 * One instance serves every pool (named per call). It never caches the JSON:
 * every operation locks, reads, mutates and writes back, so the file is the
 * only source of truth across processes.
 */
export class MachineLedger {
  private readonly bootId = readBootId();
  private dirPath: string | null = null;
  private readonly explicitDir: string | undefined;
  private readonly instanceId: string;
  /** The on-disk file's `cap` must match. */
  private readonly expectedCaps = new Map<string, ResourceCap>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { explicitDir?: string; instanceId: string }) {
    this.explicitDir = opts.explicitDir;
    this.instanceId = opts.instanceId;
  }

  /** Lazy, so construction stays synchronous; resolves once. */
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

  /** The pool's JSON file and its sibling lockdir. */
  private async pathFor(poolName: string): Promise<{ file: string; lock: string }> {
    const dir = await this.ensureDir();
    return { file: join(dir, `${poolName}.json`), lock: join(dir, `${poolName}.lock`) };
  }

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
   * A lockdir older than 30 seconds is presumed dead and released; otherwise a
   * holder SIGKILL'd mid-lock wedges the pool forever.
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

  /** A missing file reads as an empty ledger. */
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
   * Persist a reservation and return true, or false when any cap would be
   * exceeded. Dead rows are reaped first, so an orphan never squats capacity.
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

  /** Idempotent. */
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

  /** Reap dead-process rows; called periodically. */
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
   * Drop, in place, rows that point at dead processes:
   * - Different bootId: dead (host rebooted since).
   * - Same bootId, OWN instance: probe with `process.kill(pid, 0)`, which works
   *   inside this PID namespace.
   * - Same bootId, OTHER instance: keep. A peer in another PID namespace (native
   *   vs container) gets ESRCH for every pid, so probing would falsely reap and
   *   silently break the cap. Peers release on graceful shutdown; a SIGKILL'd
   *   peer's rows stay until the next reboot.
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

  /** Start the periodic reaper over every registered pool. Idempotent. */
  start(intervalMs = 30_000): void {
    if (this.reaperTimer !== null) return;
    this.reaperTimer = setInterval(() => {
      runDetached(logger, 'Machine ledger reap', () => this.reapAllPools());
    }, intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      this.reaperTimer.unref();
    }
  }

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

  /** Best-effort release of this instance's rows in every pool, on graceful shutdown. */
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
