import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuditEntry } from '@kici-dev/engine';
import { AuditLogger } from './audit-logger.js';
import type { Database } from '../db/types.js';

function makeMockDb() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const db = {
    insertInto: vi.fn(() => ({
      values: vi.fn(() => ({ execute })),
    })),
  } as unknown as Kysely<Database>;
  return { db, execute };
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action: 'resolve',
    contextName: 'global',
    routingKey: 'github:1',
    secretKeys: ['MY_KEY'],
    outcome: 'allowed',
    runId: null,
    jobId: null,
    userId: null,
    role: null,
    metadata: null,
    ...overrides,
  };
}

describe('AuditLogger.log — resolve / resolve_named sampling', () => {
  it('samples allowed `resolve` entries to ~1%', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 1000; i++) {
      await logger.log(entry({ runId: `run-${i}`, jobId: `job-${i}` }));
    }
    const inserts = execute.mock.calls.length;
    // Target 10. 3σ for binomial n=1000, p=0.01 ≈ 9.4. Allow [0, 30].
    expect(inserts).toBeLessThan(30);
  });

  it('always records denied resolves', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 50; i++) {
      await logger.log(entry({ outcome: 'denied', runId: `run-${i}` }));
    }
    expect(execute.mock.calls.length).toBe(50);
  });

  it('always records `setSecret` mutations regardless of sampling', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 20; i++) {
      await logger.log(entry({ action: 'setSecret', secretKeys: ['K'] }));
    }
    expect(execute.mock.calls.length).toBe(20);
  });

  it('always records `deleteSecret` mutations', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 20; i++) {
      await logger.log(entry({ action: 'deleteSecret' }));
    }
    expect(execute.mock.calls.length).toBe(20);
  });

  it('always records `rotateKey` operations', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 10; i++) {
      await logger.log(entry({ action: 'rotateKey' }));
    }
    expect(execute.mock.calls.length).toBe(10);
  });

  it('always records `secret-outputs.reveal` operations', async () => {
    const { db, execute } = makeMockDb();
    const logger = new AuditLogger(db);
    for (let i = 0; i < 10; i++) {
      await logger.log(entry({ action: 'secret-outputs.reveal' }));
    }
    expect(execute.mock.calls.length).toBe(10);
  });
});
