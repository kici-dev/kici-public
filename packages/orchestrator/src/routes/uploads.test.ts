import { describe, it, expect, vi } from 'vitest';
import { initTestUpload, TestUploadStorageUnavailableError } from './uploads.js';

/** Build a chainable Kysely insert mock that records the inserted row. */
function mockDb() {
  const values = vi.fn().mockReturnThis();
  const execute = vi.fn().mockResolvedValue(undefined);
  const insertInto = vi.fn().mockReturnValue({ values, execute });
  return { db: { insertInto } as any, values, execute, insertInto };
}

describe('initTestUpload', () => {
  it('returns the developer-facing presigned URL', async () => {
    const { db, values } = mockDb();
    const getUploadUrl = vi.fn().mockResolvedValue('https://agent.example/put?sig=1');
    const getInternalUploadUrl = vi.fn().mockResolvedValue('https://dev.example/put?sig=2');

    const result = await initTestUpload(
      { db, cacheStorage: { getUploadUrl, getInternalUploadUrl } as any },
      { routingKey: 'remote:org_1', sha: 'abc' },
    );

    // fails-when: the upload URL is minted with the agent-facing getUploadUrl,
    // which ignores KICI_STORAGE_UPLOAD_ENDPOINT
    expect(getInternalUploadUrl).toHaveBeenCalledTimes(1);
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(result.signedUrl).toBe('https://dev.example/put?sig=2');
    expect(result.uploadId).toBeTruthy();
    expect(result.publicKey).toBeTruthy();
    expect(result.expiresIn).toBe(3600);

    // The ephemeral private key is persisted on the row.
    const row = values.mock.calls[0][0];
    expect(row.routing_key).toBe('remote:org_1');
    expect(row.encryption_private_key).toBeTruthy();
    expect(row.status).toBe('pending');
  });

  it('throws a typed, actionable error when no cache storage is configured', async () => {
    const { db, insertInto } = mockDb();

    const run = initTestUpload(
      { db, cacheStorage: undefined },
      { routingKey: 'remote:org_1', sha: 'abc' },
    );
    await expect(run).rejects.toBeInstanceOf(TestUploadStorageUnavailableError);
    await expect(run).rejects.toThrow(/no object storage configured/i);

    // No upload row is persisted when storage is missing.
    expect(insertInto).not.toHaveBeenCalled();
  });

  it('records the createdBy actor on the upload row', async () => {
    const { db, values } = mockDb();
    await initTestUpload(
      {
        db,
        cacheStorage: {
          getUploadUrl: vi.fn(),
          getInternalUploadUrl: vi.fn().mockResolvedValue('u'),
        } as any,
      },
      { routingKey: 'remote:org_1', createdBy: 'user:sub-1' },
    );
    expect(values.mock.calls[0][0].created_by).toBe('user:sub-1');
  });
});
