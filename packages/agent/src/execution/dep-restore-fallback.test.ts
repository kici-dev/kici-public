import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { restoreDeps } from './dep-restore.js';
import { DepRestoreError, DepTarballHashMismatchError } from './dep-restore-errors.js';
import { DepRestoreOutcome, type DepRestoreReport } from './dep-restore-report.js';
import { tryRestoreDeps } from './dep-restore-fallback.js';

vi.mock('./dep-restore.js', () => ({ restoreDeps: vi.fn() }));

function report(outcome: DepRestoreOutcome): DepRestoreReport {
  return {
    outcome,
    source: 'https://bucket/deps/x.tar.gz',
    verified: false,
    attempts: [],
  };
}

const ARGS = { workDir: '/w', depsUrl: 'https://bucket/deps/x.tar.gz?sig=1', depsHash: 'h' };

describe('tryRestoreDeps', () => {
  let log: Mock<(line: string) => void>;
  let onReport: Mock<(r: DepRestoreReport) => void>;
  beforeEach(() => {
    vi.mocked(restoreDeps).mockReset();
    log = vi.fn();
    onReport = vi.fn();
  });

  it('returns true and logs the success line when restored', async () => {
    const r = { ...report(DepRestoreOutcome.enum.restored), tarballBytes: 1024, downloadMs: 10 };
    vi.mocked(restoreDeps).mockResolvedValueOnce(r);
    await expect(tryRestoreDeps({ ...ARGS, log, onReport })).resolves.toBe(true);
    expect(onReport).toHaveBeenCalledWith(r);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^Deps restored from cache: /);
    expect(restoreDeps).toHaveBeenCalledWith('/w', ARGS.depsUrl, 'h', {
      limits: undefined,
      onProgress: log,
    });
  });

  it('returns false and names the cause when the restore fails', async () => {
    // fails-when: a failed restore fails the job instead of falling back
    const r = report(DepRestoreOutcome.enum['download-failed']);
    vi.mocked(restoreDeps).mockRejectedValueOnce(
      new DepRestoreError(
        'Dep tarball download failed: Download failed after 3 attempts: HTTP 503',
        r,
      ),
    );
    await expect(tryRestoreDeps({ ...ARGS, log, onReport })).resolves.toBe(false);
    expect(onReport).toHaveBeenCalledWith(r);
    expect(log).toHaveBeenLastCalledWith(
      'Cache restore failed (Dep tarball download failed: Download failed after 3 attempts: HTTP 503), falling back to inline install',
    );
  });

  it('rethrows a hash mismatch', async () => {
    // breaks-if-wrong: a corrupted cache entry must still fail the job
    const r = report(DepRestoreOutcome.enum['hash-mismatch']);
    const err = new DepTarballHashMismatchError('aaa', 'bbb', r);
    vi.mocked(restoreDeps).mockRejectedValueOnce(err);
    await expect(tryRestoreDeps({ ...ARGS, log, onReport })).rejects.toBe(err);
    expect(onReport).toHaveBeenCalledWith(r);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^Dep tarball hash mismatch: expected aaa, got bbb/);
  });
});
