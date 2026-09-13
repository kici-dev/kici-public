/**
 * A LISTEN subscription that survives losing its connection.
 *
 * A `LISTEN` session is a single checked-out client sitting idle. A Postgres
 * failover, a restart, or an idle-backend sweep terminates it, and the pool's
 * own error handler discards the broken connection without re-acquiring — so
 * the subscription is silently gone while `/health` and `/ready` stay 200. The
 * process keeps running and never hears another NOTIFY on that channel.
 *
 * This wraps the pattern once: acquire, subscribe, `LISTEN`, and on `error` or
 * `end` release the dead client and reconnect with jittered exponential
 * backoff until `stop()`. NOTIFY has no durable log, so nothing can be
 * replayed — instead, after a successful re-`LISTEN` the consumer's
 * `onReconnect` re-derives whatever it missed from the database, which is
 * exactly what that consumer already does at cold boot.
 */
import type pg from 'pg';
import { createLogger, toErrorMessage, type Logger } from '@kici-dev/shared';
import { setPgListenConnected, pgListenReconnectsTotal } from '../metrics/prometheus.js';

const defaultLogger = createLogger({ prefix: 'notify-listener' });

export interface NotifyListenerOptions {
  pool: pg.Pool;
  /** Channel name. Interpolated into `LISTEN`, so it must be an identifier. */
  channel: string;
  onNotification: (msg: pg.Notification) => void;
  /**
   * Re-derive what the subscription missed while it was disconnected. Awaited
   * after a successful re-`LISTEN`, never on the first connect — a cold start
   * has its own load path.
   */
  onReconnect?: () => Promise<void> | void;
  logger?: Logger;
  /** First backoff step. Doubles up to {@link MAX_BACKOFF_MS}. */
  baseBackoffMs?: number;
}

export const MAX_BACKOFF_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 250;

/** Reject a channel name that is not a bare identifier. */
function assertChannel(channel: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
    throw new Error(`NotifyListener: channel "${channel}" is not a valid identifier`);
  }
}

export class NotifyListener {
  private client: pg.PoolClient | null = null;
  private stopped = false;
  private reconnecting: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly logger: Logger;
  private readonly baseBackoffMs: number;

  constructor(private readonly opts: NotifyListenerOptions) {
    assertChannel(opts.channel);
    this.logger = opts.logger ?? defaultLogger;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /** Acquire a client and subscribe. Throws if the first connect fails. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /**
   * Best-effort `UNLISTEN`, then release. Cancels any pending reconnect, so a
   * shutdown mid-backoff does not resurrect the subscription.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.reconnecting?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    setPgListenConnected(this.opts.channel, false);
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${this.opts.channel}`);
    } catch {
      // The connection may already be gone; releasing is what matters.
    }
    // pg's pool does not strip listeners a consumer attached, so a client
    // released with ours still on it carries them into whatever checks it out
    // next, and every start/stop cycle stacks another set. Both failure paths
    // in `connect` already do this before releasing.
    client.removeAllListeners();
    client.release();
  }

  /** True while a live client holds the subscription. */
  get connected(): boolean {
    return this.client !== null;
  }

  private async connect(): Promise<void> {
    const client = await this.opts.pool.connect();
    // Attach the failure handlers BEFORE the LISTEN: a backend terminated
    // between acquire and subscribe would otherwise be missed entirely.
    const onFailure = (err?: Error): void => {
      if (this.client !== client) return; // already replaced
      this.client = null;
      setPgListenConnected(this.opts.channel, false);
      this.logger.warn(`LISTEN ${this.opts.channel} lost; reconnecting`, {
        error: err ? toErrorMessage(err) : 'connection ended',
      });
      // The client is already broken, so pg discards it on release.
      try {
        client.removeAllListeners();
        client.release(err ?? new Error('listen connection ended'));
      } catch {
        // Releasing twice is harmless; the reconnect is what matters.
      }
      this.scheduleReconnect();
    };
    client.on('error', onFailure);
    client.on('end', () => onFailure());
    client.on('notification', (msg) => {
      if (msg.channel !== this.opts.channel) return;
      this.opts.onNotification(msg);
    });

    try {
      await client.query(`LISTEN ${this.opts.channel}`);
    } catch (err) {
      // The client was acquired but never became a subscription. Returning it
      // broken is what keeps a failing reconnect loop from draining the pool
      // one leaked connection per attempt.
      client.removeAllListeners();
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    this.client = client;
    this.attempt = 0;
    setPgListenConnected(this.opts.channel, true);
    this.logger.info(`LISTEN ${this.opts.channel} active`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = this.backoffMs();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnecting = this.reconnect().catch((err) => {
        this.logger.warn(`LISTEN ${this.opts.channel} reconnect failed`, {
          error: toErrorMessage(err),
        });
        this.scheduleReconnect();
      });
    }, delay);
    // Never hold the process open on a reconnect timer.
    this.timer.unref?.();
  }

  /** Exponential backoff with full jitter, capped at {@link MAX_BACKOFF_MS}. */
  private backoffMs(): number {
    const ceiling = Math.min(this.baseBackoffMs * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    return Math.round(ceiling * (0.5 + Math.random() * 0.5));
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    await this.connect();
    pgListenReconnectsTotal.add(1, { channel: this.opts.channel });
    if (this.stopped) return;
    try {
      await this.opts.onReconnect?.();
    } catch (err) {
      // A failed catch-up must not tear the subscription down again: live
      // notifications are already flowing, and the next change re-triggers
      // whatever this would have re-derived.
      this.logger.error(`Catch-up after ${this.opts.channel} reconnect failed`, {
        error: toErrorMessage(err),
      });
    }
  }
}
