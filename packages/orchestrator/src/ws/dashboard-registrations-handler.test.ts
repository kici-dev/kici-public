import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registrationsListRequestSchema,
  registrationsListResponseSchema,
  registrationItemSchema,
} from '@kici-dev/engine';
import { DashboardRegistrationsHandler } from './dashboard-registrations-handler.js';
import type { RegistrationStore, RegistrationRow } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LockWorkflow } from '@kici-dev/engine';

// --- Test fixtures ---

function makeLockWorkflow(overrides: Partial<LockWorkflow> = {}): LockWorkflow {
  return {
    name: 'deploy',
    contentHash: 'abc123',
    compileSchemaVersion: 1,
    triggers: [{ _type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' } as any],
    jobs: [],
    ...overrides,
  };
}

function makeRegistrationRow(overrides: Partial<RegistrationRow> = {}): RegistrationRow {
  return {
    id: 'reg-1',
    repo_identifier: 'org/repo',
    workflow_name: 'deploy',
    lock_entry: makeLockWorkflow(),
    trigger_types: ['schedule'],
    routing_key: 'github:42',
    provider_context: {},
    disabled: false,
    commitSha: null,
    sourceFile: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
    ...overrides,
  };
}

// --- Schema tests ---

describe('registrationsListRequestSchema', () => {
  const baseActor = { type: 'user' as const, sub: 'zsub-test' };

  it('validates a valid request with optional filters', () => {
    const valid = {
      type: 'dashboard.registrations.list',
      requestId: 'req-1',
      actor: baseActor,
      triggerType: 'schedule',
      repoIdentifier: 'org/repo',
    };
    expect(registrationsListRequestSchema.parse(valid)).toEqual(valid);
  });

  it('validates without optional filters', () => {
    const valid = {
      type: 'dashboard.registrations.list',
      requestId: 'req-1',
      actor: baseActor,
    };
    expect(registrationsListRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing requestId', () => {
    expect(() =>
      registrationsListRequestSchema.parse({
        type: 'dashboard.registrations.list',
        actor: baseActor,
      }),
    ).toThrow();
  });

  it('rejects missing actor', () => {
    expect(() =>
      registrationsListRequestSchema.parse({
        type: 'dashboard.registrations.list',
        requestId: 'req-1',
      }),
    ).toThrow();
  });
});

describe('registrationsListResponseSchema', () => {
  it('validates a response with registrations', () => {
    const valid = {
      type: 'dashboard.registrations.list.response',
      requestId: 'req-1',
      registrations: [
        {
          id: 'reg-1',
          repoIdentifier: 'org/repo',
          workflowName: 'deploy',
          triggerTypes: ['schedule'],
          triggers: [{ _type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' }],
          lastTriggeredAt: '2026-01-15T10:00:00.000Z',
          nextFireAt: '2026-01-16T00:00:00.000Z',
          sourceRepos: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      registryVersion: 5,
      registryUpdatedAt: '2026-01-02T00:00:00.000Z',
    };
    expect(registrationsListResponseSchema.parse(valid)).toBeTruthy();
  });

  it('validates a response with error', () => {
    const valid = {
      type: 'dashboard.registrations.list.response',
      requestId: 'req-1',
      registryVersion: 0,
      registryUpdatedAt: '2026-01-01T00:00:00.000Z',
      error: 'Something went wrong',
    };
    expect(registrationsListResponseSchema.parse(valid)).toBeTruthy();
  });
});

// --- Handler tests ---

describe('DashboardRegistrationsHandler', () => {
  let send: ReturnType<typeof vi.fn>;
  let registrationStore: {
    getAll: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
  };
  let registrationIndex: { getVersion: ReturnType<typeof vi.fn> };
  let db: any;
  let handler: DashboardRegistrationsHandler;

  beforeEach(() => {
    send = vi.fn();
    registrationStore = {
      getAll: vi.fn().mockResolvedValue([]),
      getVersion: vi.fn().mockResolvedValue(1),
    };
    registrationIndex = {
      getVersion: vi.fn().mockReturnValue(1),
    };
    db = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([]),
              }),
            }),
            execute: vi.fn().mockResolvedValue([]),
          }),
          execute: vi.fn().mockResolvedValue([]),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              version: 1,
              updated_at: new Date('2026-01-01'),
            }),
          }),
        }),
      }),
    };

    handler = new DashboardRegistrationsHandler({
      db: db as unknown as Kysely<Database>,
      registrationStore: registrationStore as unknown as RegistrationStore,
      registrationIndex: registrationIndex as unknown as RegistrationIndex,
      send,
      orgId: 'cust-1',
    });
  });

  it('returns enriched registrations for a customer with last_triggered_at', async () => {
    const row = makeRegistrationRow();
    registrationStore.getAll.mockResolvedValue([row]);

    // Mock execution_runs query for last triggered
    const execQueryChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([
        {
          workflow_name: 'deploy',
          repo_identifier: 'org/repo',
          last_triggered_at: new Date('2026-01-15T10:00:00Z'),
        },
      ]),
    };

    // Mock cron_last_fired query
    const cronQueryChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    };

    // Mock registry_versions query
    const versionQueryChain = {
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({
        version: 5,
        updated_at: new Date('2026-01-02'),
      }),
    };

    db.selectFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'execution_runs') return execQueryChain;
      if (table === 'cron_last_fired') return cronQueryChain;
      if (table === 'registry_versions') return versionQueryChain;
      return execQueryChain;
    });

    await handler.handle({
      type: 'dashboard.registrations.list',
      requestId: 'req-1',
    });

    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.type).toBe('dashboard.registrations.list.response');
    expect(response.requestId).toBe('req-1');
    expect(response.registrations).toHaveLength(1);
    expect(response.registrations[0].workflowName).toBe('deploy');
    expect(response.registrations[0].lastTriggeredAt).toBe('2026-01-15T10:00:00.000Z');
    expect(response.registryVersion).toBe(5);
  });

  it('computes next_fire for schedule triggers using croner', async () => {
    const row = makeRegistrationRow({
      lock_entry: makeLockWorkflow({
        triggers: [{ _type: 'schedule', cronExpression: '0 0 * * *', timezone: 'UTC' } as any],
      }),
    });
    registrationStore.getAll.mockResolvedValue([row]);

    // Mock DB queries
    const queryChain = {
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({
        version: 1,
        updated_at: new Date('2026-01-01'),
      }),
    };
    db.selectFrom = vi.fn().mockReturnValue(queryChain);

    await handler.handle({
      type: 'dashboard.registrations.list',
      requestId: 'req-2',
    });

    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.registrations[0].nextFireAt).toBeTruthy();
    // nextFireAt should be an ISO date string in the future
    expect(new Date(response.registrations[0].nextFireAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('filters by triggerType when provided', async () => {
    const scheduleRow = makeRegistrationRow({
      id: 'reg-1',
      trigger_types: ['schedule'],
    });
    const eventRow = makeRegistrationRow({
      id: 'reg-2',
      workflow_name: 'on-event',
      trigger_types: ['kici_event'],
      lock_entry: makeLockWorkflow({
        name: 'on-event',
        triggers: [{ _type: 'kici_event', eventName: 'deploy' } as any],
      }),
    });
    registrationStore.getAll.mockResolvedValue([scheduleRow, eventRow]);

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({
        version: 1,
        updated_at: new Date('2026-01-01'),
      }),
    };
    db.selectFrom = vi.fn().mockReturnValue(queryChain);

    await handler.handle({
      type: 'dashboard.registrations.list',
      requestId: 'req-3',
      triggerType: 'schedule',
    });

    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.registrations).toHaveLength(1);
    expect(response.registrations[0].workflowName).toBe('deploy');
  });

  it('filters by repoIdentifier when provided', async () => {
    registrationStore.getAll.mockResolvedValue([makeRegistrationRow()]);

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({
        version: 1,
        updated_at: new Date('2026-01-01'),
      }),
    };
    db.selectFrom = vi.fn().mockReturnValue(queryChain);

    await handler.handle({
      type: 'dashboard.registrations.list',
      requestId: 'req-4',
      repoIdentifier: 'org/repo',
    });

    expect(registrationStore.getAll).toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.registrations).toHaveLength(1);
  });

  describe('delete with cancelActiveRuns', () => {
    let deleteHandler: DashboardRegistrationsHandler;
    let deleteSend: ReturnType<typeof vi.fn>;
    let deleteStore: any;
    let deleteIndex: any;
    let deleteDb: any;

    beforeEach(() => {
      deleteSend = vi.fn();
      deleteStore = {
        getById: vi.fn(),
        deleteById: vi.fn().mockResolvedValue(true),
        bumpVersion: vi.fn().mockResolvedValue(2),
      };
      deleteIndex = {
        loadFromDb: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('cancels runs in all non-terminal states, not just pending/running', async () => {
      const reg = makeRegistrationRow({ id: 'reg-del-1' });
      deleteStore.getById.mockResolvedValue(reg);

      const capturedWhereArgs: string[][] = [];
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ numUpdatedRows: 0n }),
      };
      const selectChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn((...args: any[]) => {
          if (args[0] === 'status') capturedWhereArgs.push(args);
          return selectChain;
        }),
        execute: vi.fn().mockResolvedValue([{ run_id: 'run-1' }]),
        // The policy gate calls executeTakeFirst on the org_settings row;
        // returning undefined makes the policy permissive (default).
        executeTakeFirst: vi.fn().mockResolvedValue(undefined),
      };

      deleteDb = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        updateTable: vi.fn().mockReturnValue(updateChain),
        deleteFrom: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows: 1n }),
          }),
        }),
      };

      deleteHandler = new DashboardRegistrationsHandler({
        db: deleteDb as unknown as Kysely<Database>,
        registrationStore: deleteStore as unknown as RegistrationStore,
        registrationIndex: deleteIndex as unknown as RegistrationIndex,
        send: deleteSend,
        orgId: 'cust-1',
      });

      await deleteHandler.handle({
        type: 'dashboard.registration.delete',
        requestId: 'req-del-1',
        registrationId: 'reg-del-1',
        cancelActiveRuns: true,
      });

      // Verify the status filter uses 'not in' with terminal states
      const statusFilter = capturedWhereArgs.find((args) => args[0] === 'status');
      expect(statusFilter).toBeTruthy();
      expect(statusFilter![1]).toBe('not in');
      expect(statusFilter![2]).toEqual(
        expect.arrayContaining(['success', 'failed', 'cancelled', 'skipped']),
      );
    });
  });

  describe('not-found results', () => {
    // The `error` field on the *.result messages is the internal-error
    // channel: the Platform maps any `error` to HTTP 500. A missing
    // registration must answer `success: false` WITHOUT `error` so the
    // Platform's `!success` → 404 branch serves the structured not-found.
    let nfSend: ReturnType<typeof vi.fn>;
    let nfStore: any;
    let nfHandler: DashboardRegistrationsHandler;

    beforeEach(() => {
      nfSend = vi.fn();
      nfStore = {
        getById: vi.fn().mockResolvedValue(null),
        setDisabled: vi.fn().mockResolvedValue(false),
        deleteById: vi.fn().mockResolvedValue(false),
        bumpVersion: vi.fn().mockResolvedValue(2),
      };
      const nfDb = {
        selectFrom: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue([]),
          // Policy gate reads the org_settings row; undefined = permissive.
          executeTakeFirst: vi.fn().mockResolvedValue(undefined),
        }),
      };
      nfHandler = new DashboardRegistrationsHandler({
        db: nfDb as unknown as Kysely<Database>,
        registrationStore: nfStore as unknown as RegistrationStore,
        registrationIndex: { loadFromDb: vi.fn() } as unknown as RegistrationIndex,
        send: nfSend,
        orgId: 'cust-1',
      });
    });

    it('disable of a missing registration sends success:false without error', async () => {
      await nfHandler.handle({
        type: 'dashboard.registration.disable',
        requestId: 'req-nf-1',
        actor: { type: 'system', id: 'test' } as any,
        registrationId: 'missing-reg',
        disabled: true,
      } as any);

      expect(nfSend).toHaveBeenCalledTimes(1);
      const sent = nfSend.mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'dashboard.registration.disable.result',
        requestId: 'req-nf-1',
        success: false,
      });
      expect(sent).not.toHaveProperty('error');
    });

    it('disable whose setDisabled misses sends success:false without error', async () => {
      nfStore.getById.mockResolvedValue(makeRegistrationRow({ id: 'race-reg' }));

      await nfHandler.handle({
        type: 'dashboard.registration.disable',
        requestId: 'req-nf-2',
        actor: { type: 'system', id: 'test' } as any,
        registrationId: 'race-reg',
        disabled: true,
      } as any);

      expect(nfSend).toHaveBeenCalledTimes(1);
      const sent = nfSend.mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'dashboard.registration.disable.result',
        requestId: 'req-nf-2',
        success: false,
      });
      expect(sent).not.toHaveProperty('error');
    });

    it('delete of a missing registration sends success:false without error', async () => {
      await nfHandler.handle({
        type: 'dashboard.registration.delete',
        requestId: 'req-nf-3',
        actor: { type: 'system', id: 'test' } as any,
        registrationId: 'missing-reg',
      } as any);

      expect(nfSend).toHaveBeenCalledTimes(1);
      const sent = nfSend.mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'dashboard.registration.delete.result',
        requestId: 'req-nf-3',
        success: false,
      });
      expect(sent).not.toHaveProperty('error');
    });
  });

  describe('source enrichment', () => {
    function makeListMockDb(opts: {
      sources?: Array<{ routing_key: string; name: string; provider: string }>;
      genericSources?: Array<{
        routing_key: string;
        name: string;
        provider_type: string;
        git_config: unknown;
      }>;
    }) {
      const sourcesChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(opts.sources ?? []),
      };
      const genericChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(opts.genericSources ?? []),
      };
      const execChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        groupBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
      };
      const cronChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
      };
      const versionChain = {
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          version: 1,
          updated_at: new Date('2026-01-01'),
        }),
      };
      return vi.fn().mockImplementation((table: string) => {
        if (table === 'sources') return sourcesChain;
        if (table === 'generic_webhook_sources') return genericChain;
        if (table === 'execution_runs') return execChain;
        if (table === 'cron_last_fired') return cronChain;
        if (table === 'registry_versions') return versionChain;
        return execChain;
      });
    }

    it('enriches with github_app source when sources row matches routing_key', async () => {
      registrationStore.getAll.mockResolvedValue([
        makeRegistrationRow({ routing_key: 'github:42' }),
      ]);
      db.selectFrom = makeListMockDb({
        sources: [{ routing_key: 'github:42', name: 'Test App', provider: 'github' }],
      });

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-1',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'github:42',
        name: 'Test App',
        subtype: 'github_app',
        provider: 'github',
      });
    });

    it('enriches with universal_git subtype when generic_webhook row has git_config', async () => {
      registrationStore.getAll.mockResolvedValue([
        makeRegistrationRow({ routing_key: 'generic:cust-1:src-1' }),
      ]);
      db.selectFrom = makeListMockDb({
        genericSources: [
          {
            routing_key: 'generic:cust-1:src-1',
            name: 'Forgejo',
            provider_type: 'generic',
            git_config: { server: 'https://forgejo.example.com' },
          },
        ],
      });

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-2',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'generic:cust-1:src-1',
        name: 'Forgejo',
        subtype: 'universal_git',
        provider: 'generic',
      });
    });

    it('enriches with local subtype when generic_webhook row has provider_type=local', async () => {
      registrationStore.getAll.mockResolvedValue([
        makeRegistrationRow({ routing_key: 'generic:cust-1:src-loc' }),
      ]);
      db.selectFrom = makeListMockDb({
        genericSources: [
          {
            routing_key: 'generic:cust-1:src-loc',
            name: 'Local policy repo',
            provider_type: 'local',
            git_config: JSON.stringify({ repoBasePath: '/srv/kici/policy-repo' }),
          },
        ],
      });

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-3',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'generic:cust-1:src-loc',
        name: 'Local policy repo',
        subtype: 'local',
        provider: 'generic',
      });
    });

    it('falls back to synthetic source when neither table has the routing_key', async () => {
      registrationStore.getAll.mockResolvedValue([
        makeRegistrationRow({ routing_key: 'github:99' }),
      ]);
      db.selectFrom = makeListMockDb({});

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-4',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'github:99',
        name: null,
        subtype: null,
        provider: 'github',
      });
    });

    it('returns provider="unknown" in synthetic fallback when routing_key has no colon', async () => {
      registrationStore.getAll.mockResolvedValue([makeRegistrationRow({ routing_key: 'legacy' })]);
      db.selectFrom = makeListMockDb({});

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-5',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'legacy',
        name: null,
        subtype: null,
        provider: 'unknown',
      });
    });

    it('prefers native sources row over generic_webhook_sources for the same routing_key', async () => {
      registrationStore.getAll.mockResolvedValue([
        makeRegistrationRow({ routing_key: 'github:42' }),
      ]);
      db.selectFrom = makeListMockDb({
        sources: [{ routing_key: 'github:42', name: 'Native App', provider: 'github' }],
        genericSources: [
          {
            routing_key: 'github:42',
            name: 'Generic Imposter',
            provider_type: 'generic',
            git_config: null,
          },
        ],
      });

      await handler.handle({
        type: 'dashboard.registrations.list',
        requestId: 'req-source-6',
      });

      const response = send.mock.calls[0][0];
      expect(response.registrations[0].source).toEqual({
        routingKey: 'github:42',
        name: 'Native App',
        subtype: 'github_app',
        provider: 'github',
      });
    });
  });

  it('returns empty array when no registrations exist', async () => {
    registrationStore.getAll.mockResolvedValue([]);

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({
        version: 1,
        updated_at: new Date('2026-01-01'),
      }),
    };
    db.selectFrom = vi.fn().mockReturnValue(queryChain);

    await handler.handle({
      type: 'dashboard.registrations.list',
      requestId: 'req-5',
    });

    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.registrations).toEqual([]);
    expect(response.registryVersion).toBe(1);
  });
});
