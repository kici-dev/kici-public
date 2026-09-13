import { describe, it, expect, vi } from 'vitest';
import {
  ensureLocalSource,
  LOCAL_ORG_ID,
  LOCAL_SOURCE_NAME,
  type PlaneSeedClient,
} from './plane-seed.js';

describe('ensureLocalSource', () => {
  it('creates a local source with verification=none + repoBasePath when none exists', async () => {
    const create = vi.fn().mockResolvedValue({ source: { id: 'src-1', name: LOCAL_SOURCE_NAME } });
    const client: PlaneSeedClient = {
      listGenericSources: vi.fn().mockResolvedValue({ sources: [] }),
      createGenericSource: create,
      updateGenericSource: vi.fn(),
    };
    const res = await ensureLocalSource('http://127.0.0.1:4319', 'tok', {
      repoDir: '/tmp/clone-abc',
      client,
    });
    expect(res).toEqual({ orgId: LOCAL_ORG_ID, sourceId: 'src-1', sourceName: LOCAL_SOURCE_NAME });
    expect(create).toHaveBeenCalledWith({
      orgId: LOCAL_ORG_ID,
      name: LOCAL_SOURCE_NAME,
      providerType: 'local',
      verificationMethod: 'none',
      localConfig: { repoBasePath: '/tmp/clone-abc', inPlace: false },
    });
  });

  it('reuses + re-points an existing kici-local source (idempotent)', async () => {
    const create = vi.fn();
    const update = vi
      .fn()
      .mockResolvedValue({ source: { id: 'src-existing', name: LOCAL_SOURCE_NAME } });
    const client: PlaneSeedClient = {
      listGenericSources: vi.fn().mockResolvedValue({
        sources: [{ id: 'src-existing', name: LOCAL_SOURCE_NAME, provider_type: 'local' }],
      }),
      createGenericSource: create,
      updateGenericSource: update,
    };
    const res = await ensureLocalSource('http://127.0.0.1:4319', 'tok', {
      repoDir: '/tmp/clone-def',
      client,
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('src-existing', {
      localConfig: { repoBasePath: '/tmp/clone-def', inPlace: false },
    });
    expect(res.sourceId).toBe('src-existing');
  });

  it('marks the source in-place when opts.inPlace is true', async () => {
    const create = vi.fn().mockResolvedValue({ source: { id: 'src-1', name: LOCAL_SOURCE_NAME } });
    const client: PlaneSeedClient = {
      listGenericSources: vi.fn().mockResolvedValue({ sources: [] }),
      createGenericSource: create,
      updateGenericSource: vi.fn(),
    };
    await ensureLocalSource('http://127.0.0.1:4319', 'tok', {
      repoDir: '/repo/root',
      inPlace: true,
      client,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        localConfig: { repoBasePath: '/repo/root', inPlace: true },
      }),
    );
  });
});
