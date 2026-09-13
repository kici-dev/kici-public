import { describe, expect, it, vi } from 'vitest';

const recordMock = vi.fn();
vi.mock('../../../audit/access-log.js', () => ({
  AccessLogWriter: class {
    record = recordMock;
  },
}));
vi.mock('../../../db/client.js', () => ({
  createPool: vi.fn(() => ({ end: vi.fn(async () => undefined) })),
  createDb: vi.fn(() => ({ destroy: vi.fn(async () => undefined) })),
}));

const { adminCliActor, recordAdminCliAccessOnDb, recordAdminCliAccess } =
  await import('./admin-cli-access-log.js');

describe('adminCliActor', () => {
  it('is a service_account with a user@host id', () => {
    const actor = adminCliActor();
    expect(actor.type).toBe('service_account');
    expect(actor.id).toMatch(/.+@.+/);
  });
});

describe('recordAdminCliAccessOnDb', () => {
  it('records with source admin_cli and the given action/target/outcome', async () => {
    recordMock.mockClear();
    const db = {} as never;
    await recordAdminCliAccessOnDb(db, {
      action: 'db.reindex',
      target: { type: 'database', id: 'kici' },
      outcome: 'allowed',
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
    const arg = recordMock.mock.calls[0][0];
    expect(arg.source).toBe('admin_cli');
    expect(arg.action).toBe('db.reindex');
    expect(arg.target).toEqual({ type: 'database', id: 'kici' });
    expect(arg.actor.type).toBe('service_account');
    expect(arg.orgId).toBeNull();
  });

  it('never throws even if record rejects (best-effort)', async () => {
    recordMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      recordAdminCliAccessOnDb({} as never, {
        action: 'db.fresh',
        target: null,
        outcome: 'allowed',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordAdminCliAccess', () => {
  it('is a no-op when no audit DB URL resolves', async () => {
    recordMock.mockClear();
    const prev = process.env.KICI_DATABASE_URL;
    delete process.env.KICI_DATABASE_URL;
    try {
      await recordAdminCliAccess({ action: 'db.ensure', target: null, outcome: 'allowed' });
      expect(recordMock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.KICI_DATABASE_URL = prev;
    }
  });

  it('opens a connection and records when a URL is given', async () => {
    recordMock.mockClear();
    await recordAdminCliAccess(
      { action: 'db.ensure', target: { type: 'database', id: 'newdb' }, outcome: 'allowed' },
      'postgres://x/y',
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][0].action).toBe('db.ensure');
  });
});
