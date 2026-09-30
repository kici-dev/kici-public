import { describe, expect, it, vi } from 'vitest';
import {
  CoordinatorCredentialOutcome as Outcome,
  ensureCoordinatorCredential,
  type CoordinatorCredentialStore,
} from './coordinator-credential.js';

describe('ensureCoordinatorCredential without a database', () => {
  // fails-when: a database error escapes into decideAuth and the peer client.
  it('returns failed and logs the cause when the database fails', async () => {
    const fail = async (): Promise<never> => {
      throw new Error('connection refused');
    };
    const store: CoordinatorCredentialStore = {
      save: fail,
      findUnrevokedByInstanceId: fail,
      findLatestRevokedByInstanceId: fail,
      retireSelfIssued: fail,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const outcome = await ensureCoordinatorCredential({
      store,
      credentialFile: '/nonexistent/peer-credential',
      instanceId: 'coord-a',
      isInstanceLive: async () => false,
      logger,
    });
    expect(outcome).toBe(Outcome.Failed);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not issue this coordinator its peer credential'),
      expect.objectContaining({ instanceId: 'coord-a', error: 'connection refused' }),
    );
  });
});
