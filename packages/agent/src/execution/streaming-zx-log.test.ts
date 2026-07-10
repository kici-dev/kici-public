import { describe, expect, it } from 'vitest';
import { makeStreamingZxLog } from './streaming-zx-log.js';

/**
 * Synthetic zx log entries. zx emits `{ kind, data, verbose }` for subprocess
 * output where `verbose` encodes the per-invocation quiet/verbose decision:
 *   - ordinary (non-quiet) output   → verbose: true  (must be captured)
 *   - `$({ quiet: true })` output   → verbose: false (must be suppressed)
 */
function stdout(data: string, verbose: boolean) {
  return { kind: 'stdout', data, verbose };
}
function stderr(data: string, verbose: boolean) {
  return { kind: 'stderr', data, verbose };
}

describe('makeStreamingZxLog', () => {
  it('emits ordinary (verbose: true) stdout/stderr line by line', () => {
    const lines: string[] = [];
    const log = makeStreamingZxLog((l) => lines.push(l));
    log(stdout('hello\n', true));
    log(stderr('world\n', true));
    expect(lines).toEqual(['hello', 'world']);
  });

  it('SUPPRESSES quiet (verbose: false) output — the secret-leak guard', () => {
    const lines: string[] = [];
    const log = makeStreamingZxLog((l) => lines.push(l));
    // A `$({ quiet: true })` sops decrypt: zx flags the entry verbose:false.
    log(stdout('BUNNYNET_KICI_PROD_STORAGE_ZONE_PASSWORD: super-secret\n', false));
    log(stderr('sops: some diagnostic\n', false));
    expect(lines).toEqual([]);
  });

  it('coalesces partial chunks into whole lines before emitting', () => {
    const lines: string[] = [];
    const log = makeStreamingZxLog((l) => lines.push(l));
    log(stdout('par', true));
    log(stdout('tial line\nsecond', true));
    expect(lines).toEqual(['partial line']); // "second" still buffered (no newline)
    log(stdout(' line\n', true));
    expect(lines).toEqual(['partial line', 'second line']);
  });

  it('ignores non-output log kinds (cmd/end/cd command echo)', () => {
    const lines: string[] = [];
    const log = makeStreamingZxLog((l) => lines.push(l));
    log({ kind: 'cmd', data: 'sops -d creds.enc.yaml', verbose: true });
    log({ kind: 'end', data: '', verbose: true });
    expect(lines).toEqual([]);
  });

  it('drops blank lines but keeps a mixed quiet/verbose stream correct', () => {
    const lines: string[] = [];
    const log = makeStreamingZxLog((l) => lines.push(l));
    log(stdout('visible-1\n', true));
    log(stdout('secret-1\n', false)); // quiet — suppressed
    log(stdout('\n', true)); // blank — dropped
    log(stdout('visible-2\n', true));
    expect(lines).toEqual(['visible-1', 'visible-2']);
  });
});
