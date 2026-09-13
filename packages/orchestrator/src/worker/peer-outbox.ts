import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { readdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { JobProgress } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'peer-outbox' });

export interface OutboxRecord {
  coordUrl: string;
  message: JobProgress;
  persistedAt: number;
}

/** Durable, at-least-once store of terminal job.progress awaiting coordinator ACK. */
export class PeerOutbox {
  private readonly records = new Map<string, OutboxRecord>(); // key = recordKey()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  private static coordKey(coordUrl: string): string {
    return createHash('sha256').update(coordUrl).digest('hex').slice(0, 16);
  }

  private static recordKey(coordUrl: string, runId: string, jobId: string): string {
    return `${PeerOutbox.coordKey(coordUrl)}__${runId}__${jobId}`;
  }

  private fileFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async loadFromDisk(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, name), 'utf8');
        const rec = JSON.parse(raw) as OutboxRecord;
        if (!rec?.coordUrl || !rec?.message?.runId || !rec?.message?.jobId) {
          logger.warn('Skipping malformed outbox record', { name });
          continue;
        }
        this.records.set(
          PeerOutbox.recordKey(rec.coordUrl, rec.message.runId, rec.message.jobId),
          rec,
        );
      } catch (err) {
        logger.warn('Skipping unreadable outbox record', { name, error: toErrorMessage(err) });
      }
    }
  }

  async enqueue(coordUrl: string, message: JobProgress): Promise<void> {
    const rec: OutboxRecord = { coordUrl, message, persistedAt: this.now() };
    const key = PeerOutbox.recordKey(coordUrl, message.runId, message.jobId);
    const target = this.fileFor(key);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(rec), 'utf8');
    await this.fsync(tmp);
    await rename(tmp, target);
    await this.fsyncDir();
    this.records.set(key, rec);
  }

  /**
   * Synchronous, durably-fsynced enqueue. The terminal job status is on disk
   * before this method returns — there is no async window in which an
   * un-flushed write can be lost if the worker process is killed moments
   * later (e.g. a worker orchestrator that crashes during microVM teardown
   * right after the job completes). The asynchronous {@link enqueue} is
   * fire-and-forget at its call site, so its fsync can be dropped when the
   * event loop never runs again; this variant blocks the (infrequent,
   * once-per-job-terminal) call path until the bytes are durable instead.
   */
  enqueueSync(coordUrl: string, message: JobProgress): void {
    const rec: OutboxRecord = { coordUrl, message, persistedAt: this.now() };
    const key = PeerOutbox.recordKey(coordUrl, message.runId, message.jobId);
    const target = this.fileFor(key);
    const tmp = `${target}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(rec));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    this.fsyncDirSync();
    this.records.set(key, rec);
    logger.info('Persisted terminal job status to durable outbox', {
      runId: message.runId,
      jobId: message.jobId,
      state: message.state,
    });
  }

  async ack(coordUrl: string, runId: string, jobId: string): Promise<void> {
    const key = PeerOutbox.recordKey(coordUrl, runId, jobId);
    this.records.delete(key);
    try {
      await unlink(this.fileFor(key));
    } catch {
      // Already gone — ack is idempotent.
    }
  }

  pendingFor(coordUrl: string): OutboxRecord[] {
    return [...this.records.values()].filter((r) => r.coordUrl === coordUrl);
  }

  async prune(ttlMs: number, now: number = this.now()): Promise<number> {
    let pruned = 0;
    for (const [key, rec] of [...this.records.entries()]) {
      if (now - rec.persistedAt > ttlMs) {
        this.records.delete(key);
        try {
          await unlink(this.fileFor(key));
        } catch {
          // ignore
        }
        pruned++;
      }
    }
    if (pruned > 0) logger.warn('Pruned stale outbox records past TTL', { pruned, ttlMs });
    return pruned;
  }

  private async fsync(path: string): Promise<void> {
    try {
      const fh = await open(path, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // fsync best-effort; rename is the durability barrier on POSIX.
    }
  }

  private async fsyncDir(): Promise<void> {
    try {
      const fh = await open(this.dir, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // Directory fsync unsupported on some platforms — best-effort.
    }
  }

  private fsyncDirSync(): void {
    try {
      const fd = openSync(this.dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Directory fsync unsupported on some platforms — best-effort.
    }
  }
}
