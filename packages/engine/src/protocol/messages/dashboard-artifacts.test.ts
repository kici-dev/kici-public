import { describe, expect, it } from 'vitest';
import {
  dashboardArtifactsListRequestSchema,
  dashboardArtifactsListResponseSchema,
  artifactListItemSchema,
  dashboardPlatformToOrchSchema,
  dashboardOrchToPlatformSchema,
} from './dashboard.js';

describe('dashboard artifacts protocol', () => {
  it('validates a list request', () => {
    const req = {
      type: 'dashboard.artifacts.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      runId: 'run-1',
    };
    expect(dashboardArtifactsListRequestSchema.parse(req).runId).toBe('run-1');
  });

  it('rejects a list request with a wrong type', () => {
    const bad = {
      type: 'dashboard.attestations.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      runId: 'run-1',
    };
    expect(dashboardArtifactsListRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('validates a response with a presigned download url', () => {
    const res = {
      type: 'dashboard.artifacts.list.response',
      requestId: 'r1',
      artifacts: [
        {
          name: 'bundle',
          jobId: 'job-1',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
          createdAt: '2026-07-18T00:00:00.000Z',
          downloadUrl: 'https://storage.example/presigned',
        },
      ],
    };
    const parsed = dashboardArtifactsListResponseSchema.parse(res);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].downloadUrl).toBe('https://storage.example/presigned');
  });

  it('parses a response with downloadUrlExpiresInSeconds', () => {
    const parsed = dashboardArtifactsListResponseSchema.parse({
      type: 'dashboard.artifacts.list.response',
      requestId: 'r1',
      artifacts: [],
      downloadUrlExpiresInSeconds: 900,
    });
    expect(parsed.downloadUrlExpiresInSeconds).toBe(900);
  });

  it('parses a response omitting downloadUrlExpiresInSeconds (backward compat)', () => {
    const parsed = dashboardArtifactsListResponseSchema.parse({
      type: 'dashboard.artifacts.list.response',
      requestId: 'r1',
      artifacts: [],
    });
    expect(parsed.downloadUrlExpiresInSeconds).toBeUndefined();
  });

  it('rejects a non-positive downloadUrlExpiresInSeconds', () => {
    expect(() =>
      dashboardArtifactsListResponseSchema.parse({
        type: 'dashboard.artifacts.list.response',
        requestId: 'r1',
        artifacts: [],
        downloadUrlExpiresInSeconds: 0,
      }),
    ).toThrow();
  });

  it('allows an item with the download url omitted (expired / missing object)', () => {
    const item = {
      name: 'bundle',
      jobId: 'job-1',
      sizeBytes: 0,
      sha256: 'b'.repeat(64),
      createdAt: '2026-07-18T00:00:00.000Z',
    };
    expect(artifactListItemSchema.parse(item).downloadUrl).toBeUndefined();
  });

  it('is a member of the platform→orch and orch→platform wire unions', () => {
    const req = {
      type: 'dashboard.artifacts.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      runId: 'run-1',
    };
    expect(dashboardPlatformToOrchSchema.safeParse(req).success).toBe(true);

    const res = {
      type: 'dashboard.artifacts.list.response',
      requestId: 'r1',
      artifacts: [],
    };
    expect(dashboardOrchToPlatformSchema.safeParse(res).success).toBe(true);
  });
});
