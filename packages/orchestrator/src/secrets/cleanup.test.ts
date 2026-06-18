import { describe, it, expect, vi } from 'vitest';
import { cleanupOrphanedSecrets, createOrphanSecretCleanupHandler } from './cleanup.js';

// Mock db that tracks delete calls.
//
// NOTE: This test uses a specialized mock (per-table return values) instead of
// the shared createMockDb() from '../__test-helpers__/mock-db.js' because
// cleanupOrphanedSecrets deletes from TWO tables and needs different results per table.
function createMockDb(keyRows = 0n, outputRows = 0n) {
  const deleteFromMock = vi.fn().mockImplementation((table: string) => {
    const numDeletedRows = table === 'run_ephemeral_keys' ? keyRows : outputRows;
    return {
      where: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([{ numDeletedRows }]),
      }),
    };
  });

  return { deleteFrom: deleteFromMock } as any;
}

describe('cleanupOrphanedSecrets', () => {
  it('deletes rows older than maxAgeHours from both tables', async () => {
    const db = createMockDb(3n, 5n);

    const result = await cleanupOrphanedSecrets(db, 24);

    expect(result.keysDeleted).toBe(3);
    expect(result.outputsDeleted).toBe(5);
    expect(db.deleteFrom).toHaveBeenCalledWith('run_ephemeral_keys');
    expect(db.deleteFrom).toHaveBeenCalledWith('run_secret_outputs');
  });

  it('returns zeros when no rows match', async () => {
    const db = createMockDb(0n, 0n);

    const result = await cleanupOrphanedSecrets(db, 24);

    expect(result.keysDeleted).toBe(0);
    expect(result.outputsDeleted).toBe(0);
  });

  it('uses default maxAgeHours of 24 when not specified', async () => {
    const db = createMockDb(0n, 0n);
    const beforeCall = Date.now();

    await cleanupOrphanedSecrets(db);

    // Verify the where clause was called with a Date approximately 24 hours ago
    const keysWhereCall = db.deleteFrom.mock.results[0].value.where;
    expect(keysWhereCall).toHaveBeenCalledWith('created_at', '<', expect.any(Date));

    const cutoffDate = keysWhereCall.mock.calls[0][2] as Date;
    const expectedCutoff = beforeCall - 24 * 60 * 60 * 1000;
    // Allow 1 second of tolerance
    expect(Math.abs(cutoffDate.getTime() - expectedCutoff)).toBeLessThan(1000);
  });

  it('handles empty result arrays gracefully', async () => {
    const deleteFromMock = vi.fn().mockImplementation(() => ({
      where: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
    }));
    const db = { deleteFrom: deleteFromMock } as any;

    const result = await cleanupOrphanedSecrets(db, 12);

    expect(result.keysDeleted).toBe(0);
    expect(result.outputsDeleted).toBe(0);
  });
});

describe('createOrphanSecretCleanupHandler', () => {
  it('invokes cleanupOrphanedSecrets with the configured maxAgeHours', async () => {
    const db = createMockDb(1n, 2n);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handler = createOrphanSecretCleanupHandler({ db, maxAgeHours: 12, logger });

    await handler();

    expect(db.deleteFrom).toHaveBeenCalledWith('run_ephemeral_keys');
    expect(db.deleteFrom).toHaveBeenCalledWith('run_secret_outputs');
    expect(logger.info).toHaveBeenCalledWith('Cleaned up orphaned secret data', {
      keysDeleted: 1,
      outputsDeleted: 2,
    });
  });

  it('does not log info when no rows are deleted', async () => {
    const db = createMockDb(0n, 0n);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handler = createOrphanSecretCleanupHandler({ db, logger });

    await handler();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs at warn and re-throws on error so the scheduler records failure', async () => {
    const error = new Error('DB connection lost');
    const deleteFromMock = vi.fn().mockImplementation(() => ({
      where: vi.fn().mockReturnValue({
        execute: vi.fn().mockRejectedValue(error),
      }),
    }));
    const db = { deleteFrom: deleteFromMock } as any;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handler = createOrphanSecretCleanupHandler({ db, logger });

    await expect(handler()).rejects.toThrow(/DB connection lost/);
    expect(logger.warn).toHaveBeenCalledWith('Failed to clean up orphaned secret data', {
      error: 'DB connection lost',
    });
  });
});
