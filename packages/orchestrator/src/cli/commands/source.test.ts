/**
 * Tests for `kici-admin source` CLI subcommands.
 *
 * Coverage focus is the `list-presets` subcommand — the rest of the `source`
 * surface is exercised via the E2E tests (needs a live admin API).
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerSourceCommands } from './source.js';
import type { AdminApiClient } from '../api-client.js';
import { UNIVERSAL_GIT_PRESETS } from '../../providers/universal-git/index.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();
  registerSourceCommands(program, () => client as AdminApiClient);

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  let exitCode: number | null = null;

  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => errors.push(a.join(' '));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    const message = (err as { message?: string } | null)?.message ?? '';
    if (!message.startsWith('EXIT:')) {
      const code = (err as { code?: string } | null)?.code;
      if (!code?.startsWith('commander.')) {
        console.log = origLog;
        console.error = origError;
        process.exit = origExit;
        throw err;
      }
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
}

describe('kici-admin source list-presets', () => {
  it('prints every built-in universal-git preset in the table output', async () => {
    const { stdout, exitCode } = await runCommand(['source', 'list-presets'], {});
    expect(exitCode).toBeNull();
    for (const name of Object.keys(UNIVERSAL_GIT_PRESETS)) {
      expect(stdout).toContain(name);
    }
    // The "custom" preset has no row in UNIVERSAL_GIT_PRESETS (it's handled
    // inline by the Zod schema) but is still mentioned in the footer so
    // operators know it exists.
    expect(stdout).toContain('custom');
    expect(stdout).toContain('Push events');
  });

  it('--format json emits a machine-readable preset list', async () => {
    const { stdout, exitCode } = await runCommand(
      ['source', 'list-presets', '--format', 'json'],
      {},
    );
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('presets');
    expect(Array.isArray(parsed.presets)).toBe(true);
    const presetNames = (parsed.presets as Array<{ preset: string }>).map((p) => p.preset);
    for (const name of Object.keys(UNIVERSAL_GIT_PRESETS)) {
      expect(presetNames).toContain(name);
    }
    // Each row must carry the fields a user needs to tell presets apart.
    for (const row of parsed.presets) {
      expect(row).toHaveProperty('repoIdentifier');
      expect(row).toHaveProperty('defaultBranch');
      expect(row).toHaveProperty('pushEvents');
      expect(row).toHaveProperty('pullRequestEvents');
    }
  });

  it('does not make any API calls', async () => {
    // list-presets is a pure local dump — it must work against a client that
    // has no network methods wired up at all.
    const client = {} as Partial<AdminApiClient>;
    const { exitCode } = await runCommand(['source', 'list-presets'], client);
    expect(exitCode).toBeNull();
  });
});

describe('kici-admin source list --json', () => {
  it('emits a JSON object with github + generic keys', async () => {
    const githubSources = [
      {
        id: 's1',
        provider: 'github',
        name: 'main',
        routingKey: 'github:42',
        customerId: 'org-a',
        config: { appId: '42' },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    const genericSources = [
      {
        id: 'g1',
        customer_id: 'org-a',
        name: 'gen',
        routing_key: 'generic:org-a:gen',
        verification_method: 'none',
        verification_config: '{}',
        event_type_header: null,
        event_type_path: null,
        idempotency_key_header: null,
        idempotency_key_path: null,
        dedup_window_seconds: 300,
        max_payload_bytes: 1048576,
        allowed_events: null,
        strip_headers: '[]',
        enabled: true,
        rate_limit_rpm: 600,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        deleted_at: null,
        provider_type: 'generic',
      },
    ];
    const client: Partial<AdminApiClient> = {
      get: async <T>(path: string): Promise<T> => {
        expect(path).toBe('/api/v1/admin/sources');
        return { sources: githubSources } as unknown as T;
      },
      listGenericSources: async () => ({ sources: genericSources as any }),
    };

    const { stdout, exitCode } = await runCommand(
      ['source', 'list', '--org', 'org-a', '--json'],
      client,
    );
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('github');
    expect(parsed).toHaveProperty('generic');
    expect(parsed.github[0].routingKey).toBe('github:42');
    expect(parsed.github[0].customerId).toBe('org-a');
    expect(parsed.generic[0].routing_key).toBe('generic:org-a:gen');
  });
});

describe('kici-admin source add generic --provider-type', () => {
  it('forwards providerType=local to the admin API', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      createGenericSource: async (data) => {
        received.push(data as Record<string, unknown>);
        return {
          source: {
            id: 'g1',
            customer_id: 'org-a',
            name: 'n',
            routing_key: 'generic:org-a:g1',
            verification_method: 'none',
            verification_config: '{}',
            event_type_header: null,
            event_type_path: null,
            idempotency_key_header: null,
            idempotency_key_path: null,
            dedup_window_seconds: 300,
            max_payload_bytes: 1048576,
            allowed_events: null,
            strip_headers: '[]',
            enabled: true,
            rate_limit_rpm: 600,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
            deleted_at: null,
            provider_type: 'local',
          } as any,
        };
      },
    };

    const { exitCode } = await runCommand(
      [
        'source',
        'add',
        'generic',
        '--org',
        'org-a',
        '--name',
        'n',
        '--verification',
        'none',
        '--provider-type',
        'local',
      ],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0].providerType).toBe('local');
  });
});

describe('kici-admin source update --customer-id', () => {
  it('forwards customerId to the PATCH body', async () => {
    const received: Array<{ path: string; body: unknown }> = [];
    const client: Partial<AdminApiClient> = {
      patch: async <T>(path: string, body: unknown): Promise<T> => {
        received.push({ path, body });
        return { routingKey: 'github:42' } as unknown as T;
      },
    };

    const { exitCode } = await runCommand(
      ['source', 'update', 'github:42', '--customer-id', 'org-xyz'],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual({ customerId: 'org-xyz' });
  });
});

describe('kici-admin source get --json', () => {
  it('emits the raw source row as JSON', async () => {
    const source = {
      id: 'g1',
      customer_id: 'org-a',
      name: 'n',
      routing_key: 'generic:org-a:g1',
      verification_method: 'none',
      verification_config: '{}',
      event_type_header: null,
      event_type_path: null,
      idempotency_key_header: null,
      idempotency_key_path: null,
      dedup_window_seconds: 300,
      max_payload_bytes: 1048576,
      allowed_events: null,
      strip_headers: '[]',
      enabled: true,
      rate_limit_rpm: 600,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      deleted_at: null,
    };
    const client: Partial<AdminApiClient> = {
      getGenericSource: async () => ({ source: source as any }),
    };
    const { stdout, exitCode } = await runCommand(['source', 'get', 'g1', '--json'], client);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe('g1');
    expect(parsed.routing_key).toBe('generic:org-a:g1');
  });
});

function fakeGenericSourceResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g-local',
    customer_id: 'org-a',
    name: 'policy-repo',
    routing_key: 'generic:org-a:g-local',
    verification_method: 'none',
    verification_config: '{}',
    event_type_header: 'x-event-type',
    event_type_path: null,
    idempotency_key_header: null,
    idempotency_key_path: null,
    dedup_window_seconds: 300,
    max_payload_bytes: 1048576,
    allowed_events: null,
    strip_headers: '[]',
    enabled: true,
    rate_limit_rpm: 600,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    deleted_at: null,
    provider_type: 'local',
    git_config: JSON.stringify({ repoBasePath: '/srv/kici/policy-repo' }),
    ...overrides,
  };
}

describe('kici-admin source add local', () => {
  it('forwards providerType=local, verification=none, and localConfig with an absolute path', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      createGenericSource: async (data) => {
        received.push(data as Record<string, unknown>);
        return { source: fakeGenericSourceResponse() as any };
      },
    };
    const { exitCode } = await runCommand(
      [
        'source',
        'add',
        'local',
        '--org',
        'org-a',
        '--name',
        'policy-repo',
        '--path',
        '/srv/kici/policy-repo',
      ],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0].providerType).toBe('local');
    expect(received[0].verificationMethod).toBe('none');
    expect(received[0].localConfig).toEqual({ repoBasePath: '/srv/kici/policy-repo' });
  });

  it('forwards cloneUrlBase when --clone-url-base is set', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      createGenericSource: async (data) => {
        received.push(data as Record<string, unknown>);
        return { source: fakeGenericSourceResponse() as any };
      },
    };
    await runCommand(
      [
        'source',
        'add',
        'local',
        '--org',
        'org-a',
        '--name',
        'policy-repo',
        '--path',
        '/srv/kici/policy-repo',
        '--clone-url-base',
        'git://host/path',
      ],
      client,
    );
    expect((received[0].localConfig as Record<string, unknown>).cloneUrlBase).toBe(
      'git://host/path',
    );
  });

  it('rejects a relative --path before any API call', async () => {
    let called = false;
    const client: Partial<AdminApiClient> = {
      createGenericSource: async () => {
        called = true;
        return { source: fakeGenericSourceResponse() as any };
      },
    };
    const { exitCode } = await runCommand(
      [
        'source',
        'add',
        'local',
        '--org',
        'org-a',
        '--name',
        'policy-repo',
        '--path',
        'relative/path',
      ],
      client,
    );
    expect(called).toBe(false);
    expect(exitCode).toBe(1);
  });
});

describe('kici-admin source update-local', () => {
  it('forwards localConfig with the new path', async () => {
    const received: Array<{ id: string; data: Record<string, unknown> }> = [];
    const client: Partial<AdminApiClient> = {
      updateGenericSource: async (id, data) => {
        received.push({ id, data: data as Record<string, unknown> });
        return {
          source: fakeGenericSourceResponse({
            git_config: JSON.stringify({ repoBasePath: '/new/path' }),
          }) as any,
        };
      },
    };
    const { exitCode } = await runCommand(
      ['source', 'update-local', 'g-local', '--path', '/new/path'],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('g-local');
    expect(received[0].data.localConfig).toEqual({ repoBasePath: '/new/path' });
  });

  it('rejects a relative --path before any API call', async () => {
    let called = false;
    const client: Partial<AdminApiClient> = {
      updateGenericSource: async () => {
        called = true;
        return { source: fakeGenericSourceResponse() as any };
      },
    };
    const { exitCode } = await runCommand(
      ['source', 'update-local', 'g-local', '--path', 'relative'],
      client,
    );
    expect(called).toBe(false);
    expect(exitCode).toBe(1);
  });
});

describe('kici-admin source remove --local', () => {
  it('soft-deletes via deleteGenericSource (id treated as source id)', async () => {
    const received: Array<{ id: string; hard?: boolean }> = [];
    const client: Partial<AdminApiClient> = {
      deleteGenericSource: async (id, hard) => {
        received.push({ id, hard });
        return { deleted: true, hard: !!hard };
      },
    };
    const { exitCode } = await runCommand(
      ['source', 'remove', 'g-local', '--local', '--yes'],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toEqual([{ id: 'g-local', hard: undefined }]);
  });
});
