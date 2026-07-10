import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./compile.js', () => ({ compileCommand: vi.fn().mockResolvedValue(true) }));
vi.mock('../execution/index.js', () => ({ resolveKiciDir: () => '/repo/.kici' }));
const resolvePlaneForRun = vi.fn().mockResolvedValue({
  kind: 'offline',
  plane: {
    running: true,
    url: 'http://127.0.0.1:4319',
    adminToken: 'kici-local-tok',
    mode: 'independent',
  },
});
vi.mock('../local-plane/resolve-plane.js', () => ({
  resolvePlaneForRun: (...a: unknown[]) => resolvePlaneForRun(...a),
}));
vi.mock('../local-plane/source-provider.js', () => ({
  resolveWorkdir: vi.fn().mockResolvedValue({
    dir: '/tmp/clone-x',
    ref: 'refs/heads/kici-local',
    sha: 'deadbeef',
    branch: 'kici-local',
    cleanup: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../local-plane/plane-seed.js', () => ({
  ensureLocalSource: vi
    .fn()
    .mockResolvedValue({ orgId: '__default__', sourceId: 'src-1', sourceName: 'kici-local' }),
}));
vi.mock('../local-plane/plane-trigger.js', () => ({
  triggerRun: vi.fn().mockResolvedValue('run-42'),
}));
const restoreLock = vi.fn();
const injectRunsOnLabel = vi.fn(() => ({ restore: restoreLock }));
vi.mock('../local-plane/trusted-routing.js', () => ({
  injectRunsOnLabel: (...a: unknown[]) => injectRunsOnLabel(...a),
}));
vi.mock('../local-plane/run-follow.js', () => ({
  followRun: vi.fn().mockResolvedValue({
    runId: 'run-42',
    status: 'success',
    jobs: [{ name: 'build', status: 'success' }],
  }),
}));

describe('readDispatchPayload', () => {
  it('returns empty when no payload path is given', async () => {
    const { readDispatchPayload } = await import('./run-routed.js');
    expect(readDispatchPayload(undefined)).toEqual({});
  });

  it('parses action + client_payload from the payload file', async () => {
    const { readDispatchPayload } = await import('./run-routed.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kici-payload-test-'));
    const file = path.join(dir, 'dispatch.json');
    writeFileSync(file, JSON.stringify({ action: 'deploy-stg', client_payload: { mode: 'full' } }));
    expect(readDispatchPayload(file)).toEqual({
      action: 'deploy-stg',
      clientPayload: { mode: 'full' },
    });
  });
});

describe('runRoutedCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces a plane-resolution error (e.g. --connected while unattached) as failure', async () => {
    resolvePlaneForRun.mockResolvedValueOnce({
      error: 'Not attached. Run `kici local attach` first.',
    });
    const { runRoutedCommand } = await import('./run-routed.js');
    expect(
      await runRoutedCommand({ local: true, connected: true, event: 'push', quiet: true }),
    ).toBe(false);
  });

  it('errors without --local', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    expect(await runRoutedCommand({ event: 'push', quiet: true })).toBe(false);
  });

  it('errors when --local is set but no event is given', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    expect(await runRoutedCommand({ local: true, quiet: true })).toBe(false);
  });

  it('drives the offline routed run and returns true on success', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    const { triggerRun } = await import('../local-plane/plane-trigger.js');
    const { resolveWorkdir } = await import('../local-plane/source-provider.js');
    const ok = await runRoutedCommand({
      local: true,
      offline: true,
      event: 'push',
      quiet: true,
    });
    expect(ok).toBe(true);
    // Triggered with the resolved workdir's git coordinates + the seeded source.
    expect(triggerRun).toHaveBeenCalledWith(
      'http://127.0.0.1:4319',
      'kici-local-tok',
      expect.objectContaining({
        orgId: '__default__',
        // The webhook route resolves by source name, not the UUID.
        sourceId: 'kici-local',
        repoFullName: '.',
        event: 'push',
        ref: 'refs/heads/kici-local',
        sha: 'deadbeef',
      }),
    );
    // The isolated workdir cleanup runs.
    const wd = await (resolveWorkdir as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(wd.cleanup).toHaveBeenCalled();
  });

  it('--in-place resolves the working tree directly', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    const { resolveWorkdir } = await import('../local-plane/source-provider.js');
    await runRoutedCommand({
      local: true,
      offline: true,
      inPlace: true,
      event: 'push',
      quiet: true,
    });
    expect(resolveWorkdir).toHaveBeenCalledWith({ inPlace: true, repoRoot: '/repo' });
  });

  it('does NOT patch the lock for a non-trusted run (default-off)', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    await runRoutedCommand({ local: true, offline: true, event: 'push', quiet: true });
    expect(injectRunsOnLabel).not.toHaveBeenCalled();
  });

  it('--trusted appends the self-hosted routing label to the workdir lock and restores it', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    const ok = await runRoutedCommand({
      local: true,
      offline: true,
      trusted: true,
      event: 'push',
      quiet: true,
    });
    expect(ok).toBe(true);
    // Patches the workdir lock (resolveWorkdir mock returns dir '/tmp/clone-x').
    expect(injectRunsOnLabel).toHaveBeenCalledWith(
      '/tmp/clone-x/.kici/kici.lock.json',
      'self-hosted',
    );
    // restore() fires in the finally so an in-place tree is left clean.
    expect(restoreLock).toHaveBeenCalledTimes(1);
  });

  it('--trusted --in-place appends BOTH self-hosted and in-place routing labels', async () => {
    const { runRoutedCommand } = await import('./run-routed.js');
    const ok = await runRoutedCommand({
      local: true,
      offline: true,
      trusted: true,
      inPlace: true,
      event: 'dispatch',
      quiet: true,
    });
    expect(ok).toBe(true);
    expect(injectRunsOnLabel).toHaveBeenCalledWith(
      '/tmp/clone-x/.kici/kici.lock.json',
      'self-hosted',
    );
    expect(injectRunsOnLabel).toHaveBeenCalledWith('/tmp/clone-x/.kici/kici.lock.json', 'in-place');
    // Both label injections' restores fire in the finally.
    expect(restoreLock).toHaveBeenCalledTimes(2);
  });

  it('--trusted restores the lock even when the run throws', async () => {
    const { followRun } = await import('../local-plane/run-follow.js');
    (followRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const { runRoutedCommand } = await import('./run-routed.js');
    const ok = await runRoutedCommand({
      local: true,
      offline: true,
      trusted: true,
      event: 'push',
      quiet: true,
    });
    expect(ok).toBe(false);
    expect(restoreLock).toHaveBeenCalledTimes(1);
  });
});
