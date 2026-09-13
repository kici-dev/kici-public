import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVerifiedIssuerPoller } from './verified-issuer-poller.js';
import type { VerifiedIssuerReader } from './verified-issuer.js';

function readerSeq(values: Array<string | null>): VerifiedIssuerReader {
  let i = 0;
  return {
    tryGetString: async () => ({
      ok: true,
      value: values[Math.min(i++, values.length - 1)] ?? null,
    }),
  } as VerifiedIssuerReader;
}

/** Like {@link readerSeq}, with `'unreadable'` standing in for a failed read. */
function readerSeqWithFailures(values: Array<string | null | 'unreadable'>): VerifiedIssuerReader {
  let i = 0;
  return {
    tryGetString: async () => {
      const v = values[Math.min(i++, values.length - 1)] ?? null;
      return v === 'unreadable' ? { ok: false } : { ok: true, value: v };
    },
  } as VerifiedIssuerReader;
}

describe('startVerifiedIssuerPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays silent while the setting is unchanged', async () => {
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeq([null, null, null]),
      initial: null,
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a change once, then stays silent on the new value', async () => {
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeq([null, 'https://orch.example.com', 'https://orch.example.com']),
      initial: null,
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(onChange.mock.calls).toEqual([['https://orch.example.com']]);
  });

  it('reports a clear back to null', async () => {
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeq([null]),
      initial: 'https://orch.example.com',
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(onChange.mock.calls).toEqual([[null]]);
  });

  it('stops polling after the returned stop function runs', async () => {
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeq(['a', 'b', 'c']),
      initial: null,
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a thrown read rather than dying', async () => {
    // The real reader reports `{ ok: false }` and never throws, so this covers
    // the poller's defensive catch: the tick body is a floating promise inside
    // an interval, and an uncaught rejection there would crash the process.
    const onChange = vi.fn();
    let call = 0;
    const reader = {
      tryGetString: async () => {
        call += 1;
        if (call === 1) throw new Error('db down');
        return { ok: true, value: 'https://orch.example.com' };
      },
    } as VerifiedIssuerReader;
    const stop = startVerifiedIssuerPoller({ reader, initial: null, intervalMs: 1000, onChange });
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    expect(onChange.mock.calls).toEqual([['https://orch.example.com']]);
  });

  it('holds the last known issuer through an unreadable tick', async () => {
    // The load-bearing case. A transient DB failure must not look like an
    // opt-out: broadcasting null here would move the browser's key-fetch trust
    // root back to the hosted control plane for the length of the blip.
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeqWithFailures(['unreadable', 'https://orch.example.com']),
      initial: 'https://orch.example.com',
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    // Downgrade-then-restore would be two calls; holding is none.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never downgrades however long the setting stays unreadable', async () => {
    // No staleness bound: a held value is held for as long as the read fails.
    // Downgrading on a timer would just reintroduce the bug more slowly.
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeqWithFailures(['unreadable']),
      initial: 'https://orch.example.com',
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still reports a real opt-out that follows an unreadable tick', async () => {
    // Holding must not swallow a genuine clear. The timing assertion is what
    // makes this discriminating: a poller that treats unreadable as null fires
    // at the FIRST tick, not the second.
    const onChange = vi.fn();
    const stop = startVerifiedIssuerPoller({
      reader: readerSeqWithFailures(['unreadable', null]),
      initial: 'https://orch.example.com',
      intervalMs: 1000,
      onChange,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(onChange.mock.calls).toEqual([[null]]);
  });

  it('skips a tick while the previous read is still in flight', async () => {
    const onChange = vi.fn();
    let started = 0;
    let release: (() => void) | null = null;
    const reader = {
      tryGetString: async () => {
        started += 1;
        await new Promise<void>((res) => {
          release = res;
        });
        return { ok: true, value: 'https://orch.example.com' };
      },
    } as VerifiedIssuerReader;
    const stop = startVerifiedIssuerPoller({ reader, initial: null, intervalMs: 1000, onChange });
    // Three ticks elapse while the first read is still pending.
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toBe(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.calls).toEqual([['https://orch.example.com']]);
    stop();
  });
});
