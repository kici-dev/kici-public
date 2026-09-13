import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runsArtifactsListCommand } from './list.js';
import * as clientMod from '../../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

const oneArtifact = {
  artifacts: [
    {
      name: 'app',
      jobId: 'build',
      sizeBytes: 1024,
      sha256: 'deadbeefcafe0123456789',
      createdAt: '2026-07-24T00:00:00.000Z',
      downloadUrl: 'https://s3.example/app?sig=1',
    },
  ],
  downloadUrlExpiresInSeconds: 900,
};

function mockList(result: unknown): void {
  vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
    listArtifacts: async () => result,
  } as never);
}

describe('runsArtifactsListCommand', () => {
  it('renders a table of artifacts', async () => {
    mockList(oneArtifact);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsListCommand('run-1', {});
    expect(ok).toBe(true);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('app');
    expect(out).toContain('build');
    // sha is truncated to its 12-char prefix in the table
    expect(out).toContain('deadbeefcafe');
    expect(out).not.toContain('deadbeefcafe0123456789');
  });

  it('marks an entry whose object could not be presigned', async () => {
    mockList({ artifacts: [{ ...oneArtifact.artifacts[0], downloadUrl: undefined }] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsListCommand('run-1', {});
    expect(ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('unavailable');
  });

  it('emits raw JSON with --json', async () => {
    mockList(oneArtifact);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsListCommand('run-1', { json: true });
    expect(ok).toBe(true);
    const parsed = JSON.parse(log.mock.calls[0][0] as string) as typeof oneArtifact;
    expect(parsed.artifacts[0].name).toBe('app');
    expect(parsed.downloadUrlExpiresInSeconds).toBe(900);
  });

  it('reports an empty state', async () => {
    mockList({ artifacts: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsArtifactsListCommand('run-1', {});
    expect(ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No artifacts');
  });

  it('returns false on a client error', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockRejectedValue(
      new clientMod.DashboardClientError('not_found', 'Not found.'),
    );
    const errs: string[] = [];
    vi.spyOn(logger, 'error').mockImplementation(((m: string) => void errs.push(m)) as never);
    const ok = await runsArtifactsListCommand('missing', {});
    expect(ok).toBe(false);
    expect(errs.join('\n')).toContain('Not found.');
  });
});
