/**
 * Keeps the control plane's cached view of the Verified-tier issuer current.
 *
 * The capability broadcast happens on connect, so a `dashboard_verified_issuer`
 * change would otherwise stay invisible until the orchestrator reconnects — and
 * a browser that is told the wrong issuer fails closed rather than sending a
 * value, so a stale value blocks writes rather than merely mislabelling a
 * control.
 *
 * Polling rather than an in-process event: the setting lives in shared cluster
 * state, so every coordinator converges on its own next read. An event only
 * reaches the coordinator that handled the write, and the control plane may
 * resolve a browser to any of the others.
 *
 * An unreadable tick HOLDS the last known issuer rather than reporting a
 * change. "Could not read the setting" and "the operator opted out" would
 * otherwise be the same event, so a transient database failure would move the
 * browser's key-fetch trust root back to the hosted control plane until the
 * next successful poll. There is no staleness bound: downgrading on a timer
 * would reintroduce that silently, just more slowly.
 *
 * The surrounding try/catch is defence-in-depth, not the failure path — the
 * reader reports `{ ok: false }` and never rejects. It stays because the tick
 * body is a floating promise inside an interval, where an uncaught rejection
 * would take down the process.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { tryResolveVerifiedIssuer, type VerifiedIssuerReader } from './verified-issuer.js';

const logger = createLogger({ prefix: 'orch:verified-issuer-poller' });

export interface VerifiedIssuerPollerOptions {
  reader: VerifiedIssuerReader;
  /** The value already broadcast, so the first tick only fires on a real change. */
  initial: string | null;
  intervalMs: number;
  onChange: (issuer: string | null) => void;
}

/** Start polling. Returns the stop function. */
export function startVerifiedIssuerPoller(opts: VerifiedIssuerPollerOptions): () => void {
  let last = opts.initial;
  // A read that outlives its tick must not race the next one: two in-flight
  // reads can resolve out of order and leave `last` — and therefore the control
  // plane's cached issuer — on the older value.
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void (async () => {
      try {
        const read = await tryResolveVerifiedIssuer(opts.reader);
        if (!read.ok) {
          // Hold: leave `last` alone so the next readable tick still compares
          // against the value the control plane actually has.
          logger.warn('cluster settings unreadable; holding the last known verified issuer');
          return;
        }
        if (read.issuer === last) return;
        last = read.issuer;
        opts.onChange(read.issuer);
      } catch (err) {
        logger.warn('Failed to re-read the verified issuer setting', {
          error: toErrorMessage(err),
        });
      } finally {
        reading = false;
      }
    })();
  }, opts.intervalMs);
  // Never hold the process open for a config poll.
  timer.unref?.();
  return () => clearInterval(timer);
}
