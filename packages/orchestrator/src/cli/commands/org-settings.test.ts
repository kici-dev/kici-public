/**
 * Tests for `kici-admin org-settings global-workflows` CLI subcommands.
 *
 * Verifies that each subcommand:
 *  - Talks to the orchestrator admin API (NEVER touches the DB directly)
 *  - Maps flags and positional args to the correct HTTP shape
 *  - Formats output as either a table or JSON
 *  - Honours the `--source <routingKey>` qualifier to scope a list entry to
 *    one webhook source (omitting it stores an unqualified entry)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerOrgSettingsCommands } from './org-settings.js';
import type { AdminApiClient } from '../api-client.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const ORG = 'kiciStg00001';

const SAMPLE_SETTINGS = {
  customerId: ORG,
  enabled: true,
  allowedRepos: [{ pattern: 'myorg/ci-*' }],
  deniedRepos: null,
  elevatedRepos: null,
  allowHttpNpmRegistries: false,
  userCacheQuotaBytes: null,
  userCacheTtlMs: null,
  createdAt: '2026-04-17T10:00:00Z',
  updatedAt: '2026-04-17T10:00:00Z',
};

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();

  registerOrgSettingsCommands(program, () => client as AdminApiClient);

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  let exitCode: number | null = null;

  console.log = (...a: any[]) => logs.push(a.join(' '));
  console.error = (...a: any[]) => errors.push(a.join(' '));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as any;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err: any) {
    if (!err.message?.startsWith('EXIT:')) {
      if (err.code?.startsWith('commander.')) {
        // commander exit
      } else {
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

describe('kici-admin org-settings global-workflows', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show --format json emits the raw settings object', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--customer-id', ORG, '--format', 'json'],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
    expect(JSON.parse(stdout)).toEqual(SAMPLE_SETTINGS);
  });

  it('show defaults to a human-readable table', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--customer-id', ORG],
      client,
    );
    expect(stdout).toContain('Customer/org id:');
    expect(stdout).toContain(ORG);
    expect(stdout).toContain('Enabled:');
    expect(stdout).toContain('Allowed authors:');
    expect(stdout).toContain('Denied source repos:');
  });

  it('show accepts --org as an alias for --customer-id', async () => {
    await runCommand(
      ['org-settings', 'global-workflows', 'show', '--org', ORG, '--format', 'json'],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
  });

  it('set-enabled true patches the enabled flag', async () => {
    await runCommand(
      ['org-settings', 'global-workflows', 'set-enabled', 'true', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      enabled: true,
    });
  });

  it('set-enabled false patches the flag as false', async () => {
    await runCommand(
      ['org-settings', 'global-workflows', 'set-enabled', 'false', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      enabled: false,
    });
  });

  it('set-enabled rejects a non-boolean value with exit 1', async () => {
    const { exitCode, stderr } = await runCommand(
      ['org-settings', 'global-workflows', 'set-enabled', 'yes', '--customer-id', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be "true" or "false"');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('allow-add appends a new unqualified entry', async () => {
    mockGet.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, allowedRepos: [{ pattern: 'myorg/ci-*' }] },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        allowedRepos: [{ pattern: 'myorg/ci-*' }, { pattern: 'myorg/deploy' }],
      },
    });
    await runCommand(
      ['org-settings', 'global-workflows', 'allow-add', 'myorg/deploy', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      allowedRepos: [{ pattern: 'myorg/ci-*' }, { pattern: 'myorg/deploy' }],
    });
  });

  it('allow-add with --source pins the entry to a routing key', async () => {
    mockGet.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, allowedRepos: null },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        allowedRepos: [{ routingKey: 'github:42', pattern: 'myorg/deploy' }],
      },
    });
    await runCommand(
      [
        'org-settings',
        'global-workflows',
        'allow-add',
        'myorg/deploy',
        '--customer-id',
        ORG,
        '--source',
        'github:42',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      allowedRepos: [{ routingKey: 'github:42', pattern: 'myorg/deploy' }],
    });
  });

  it('allow-add is a no-op when an exact-match entry is already present', async () => {
    mockGet.mockResolvedValueOnce({ settings: SAMPLE_SETTINGS });
    const { stdout } = await runCommand(
      ['org-settings', 'global-workflows', 'allow-add', 'myorg/ci-*', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).not.toHaveBeenCalled();
    expect(stdout).toContain('already present');
  });

  it('allow-add inserts a source-qualified entry alongside an unqualified twin', async () => {
    // The same `pattern` may legitimately appear once unqualified and once
    // pinned to a specific source — they are different entries.
    mockGet.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, allowedRepos: [{ pattern: 'myorg/ci-*' }] },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        allowedRepos: [
          { pattern: 'myorg/ci-*' },
          { routingKey: 'github:42', pattern: 'myorg/ci-*' },
        ],
      },
    });
    await runCommand(
      [
        'org-settings',
        'global-workflows',
        'allow-add',
        'myorg/ci-*',
        '--customer-id',
        ORG,
        '--source',
        'github:42',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      allowedRepos: [{ pattern: 'myorg/ci-*' }, { routingKey: 'github:42', pattern: 'myorg/ci-*' }],
    });
  });

  it('deny-remove filters an unqualified pattern out of the deny list', async () => {
    mockGet.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        deniedRepos: [{ pattern: 'a' }, { pattern: 'b' }],
      },
    });
    mockPatch.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, deniedRepos: [{ pattern: 'a' }] },
    });
    await runCommand(
      ['org-settings', 'global-workflows', 'deny-remove', 'b', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      deniedRepos: [{ pattern: 'a' }],
    });
  });

  it('deny-remove --source targets a source-qualified entry only', async () => {
    mockGet.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        deniedRepos: [{ pattern: 'myorg/x' }, { routingKey: 'github:42', pattern: 'myorg/x' }],
      },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        deniedRepos: [{ pattern: 'myorg/x' }],
      },
    });
    await runCommand(
      [
        'org-settings',
        'global-workflows',
        'deny-remove',
        'myorg/x',
        '--customer-id',
        ORG,
        '--source',
        'github:42',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      deniedRepos: [{ pattern: 'myorg/x' }],
    });
  });

  // Universal-git sources participate in the same axes via their
  // `generic:<orgId>:<sourceId>` routing key. The admin API treats the routing
  // key as an opaque string in the qualifier, so provider-prefixed keys round
  // trip exactly as github:* keys do.
  it('allow-add supports a universal-git --source qualifier', async () => {
    const genericKey = 'generic:kiciStg00001:src-abc';
    mockGet.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, allowedRepos: null },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        allowedRepos: [{ routingKey: genericKey, pattern: 'forgejo.example.com/team/**' }],
      },
    });
    await runCommand(
      [
        'org-settings',
        'global-workflows',
        'allow-add',
        'forgejo.example.com/team/**',
        '--customer-id',
        ORG,
        '--source',
        genericKey,
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      allowedRepos: [{ routingKey: genericKey, pattern: 'forgejo.example.com/team/**' }],
    });
  });

  it('elevate-add appends to the elevated list', async () => {
    mockGet.mockResolvedValueOnce({
      settings: { ...SAMPLE_SETTINGS, elevatedRepos: [{ pattern: 'myorg/deploy' }] },
    });
    mockPatch.mockResolvedValueOnce({
      settings: {
        ...SAMPLE_SETTINGS,
        elevatedRepos: [{ pattern: 'myorg/deploy' }, { pattern: 'myorg/release' }],
      },
    });
    await runCommand(
      ['org-settings', 'global-workflows', 'elevate-add', 'myorg/release', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      elevatedRepos: [{ pattern: 'myorg/deploy' }, { pattern: 'myorg/release' }],
    });
  });
});

describe('kici-admin org-settings user-cache', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show prints the per-org quota + TTL (cluster default when null)', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'user-cache', 'show', '--customer-id', ORG],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
    expect(stdout).toContain('User-cache quota:');
    expect(stdout).toContain('(cluster default)');
  });

  it('set-quota patches userCacheQuotaBytes with a positive integer', async () => {
    await runCommand(
      ['org-settings', 'user-cache', 'set-quota', '1073741824', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      userCacheQuotaBytes: 1073741824,
    });
  });

  it('set-ttl patches userCacheTtlMs with a positive integer', async () => {
    await runCommand(
      ['org-settings', 'user-cache', 'set-ttl', '3600000', '--customer-id', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      userCacheTtlMs: 3600000,
    });
  });

  it('reset-quota patches userCacheQuotaBytes to null (cluster default)', async () => {
    await runCommand(['org-settings', 'user-cache', 'reset-quota', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      userCacheQuotaBytes: null,
    });
  });

  it('reset-ttl patches userCacheTtlMs to null (cluster default)', async () => {
    await runCommand(['org-settings', 'user-cache', 'reset-ttl', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      userCacheTtlMs: null,
    });
  });

  it('set-quota rejects a non-positive / non-integer value with exit 1', async () => {
    const { exitCode, stderr } = await runCommand(
      ['org-settings', 'user-cache', 'set-quota', '0', '--customer-id', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('positive integer');
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('kici-admin org-settings dashboard-writes', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  const DW_RESPONSE_EMPTY = {
    customerId: ORG,
    stored: {},
    effective: {
      'secrets.set': true,
      'secrets.delete': true,
      'secrets.scope.create': true,
      'secrets.scope.rename': true,
      'secrets.scope.delete': true,
      'variables.set': true,
      'variables.delete': true,
      'environments.create': true,
      'environments.update': true,
      'environments.delete': true,
      'environments.bindings.set': true,
      'environments.source_overrides.set': true,
      'environments.source_overrides.delete': true,
      'held_runs.approve': true,
      'held_runs.reject': true,
      'event_dlq.retry': true,
      'event_dlq.discard': true,
      'registration.disable': true,
      'registration.delete': true,
      'global_workflows.update': true,
      'backends.sync': true,
      'backends.sync_one': true,
      'backends.test': true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue(DW_RESPONSE_EMPTY);
    mockPatch = vi.fn().mockResolvedValue(DW_RESPONSE_EMPTY);
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show --format json prints the full policy view', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'show', '--org', ORG, '--format', 'json'],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/dashboard-writes?customerId=${ORG}`,
    );
    expect(result.exitCode).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(DW_RESPONSE_EMPTY);
  });

  it('show table mode groups operations by category', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'show', '--org', ORG],
      client,
    );
    expect(result.stdout).toContain('SECRETS');
    expect(result.stdout).toContain('secrets.set');
    expect(result.stdout).toContain('enabled');
  });

  it('show --category=Secrets filters to one category', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'show', '--org', ORG, '--category', 'Secrets'],
      client,
    );
    expect(result.stdout).toContain('secrets.set');
    expect(result.stdout).not.toContain('variables.set');
    expect(result.stdout).not.toContain('held_runs.approve');
  });

  it('show --sensitivity=plaintext filters to plaintext ops', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'show', '--org', ORG, '--sensitivity', 'plaintext'],
      client,
    );
    expect(result.stdout).toContain('secrets.set');
    expect(result.stdout).toContain('variables.set');
    expect(result.stdout).not.toContain('secrets.delete');
  });

  it('set --op flips a single operation', async () => {
    await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'secrets.set=false'],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      updates: { 'secrets.set': false },
    });
  });

  it('set accepts multiple --op flags', async () => {
    await runCommand(
      [
        'org-settings',
        'dashboard-writes',
        'set',
        '--org',
        ORG,
        '--op',
        'secrets.set=false',
        '--op',
        'variables.set=false',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      updates: { 'secrets.set': false, 'variables.set': false },
    });
  });

  it('set --category --enabled flips a whole group', async () => {
    await runCommand(
      [
        'org-settings',
        'dashboard-writes',
        'set',
        '--org',
        ORG,
        '--category',
        'Secrets',
        '--enabled',
        'false',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const body = mockPatch.mock.calls[0]?.[1] as {
      updates: Record<string, boolean>;
    };
    expect(body.updates['secrets.set']).toBe(false);
    expect(body.updates['secrets.delete']).toBe(false);
    expect(body.updates['secrets.scope.create']).toBe(false);
    expect(body.updates['variables.set']).toBeUndefined();
  });

  it('set --sensitivity=plaintext --enabled=false flips secrets.set + variables.set', async () => {
    await runCommand(
      [
        'org-settings',
        'dashboard-writes',
        'set',
        '--org',
        ORG,
        '--sensitivity',
        'plaintext',
        '--enabled',
        'false',
      ],
      client,
    );
    const body = mockPatch.mock.calls[0]?.[1] as {
      updates: Record<string, boolean>;
    };
    expect(body.updates).toEqual({ 'secrets.set': false, 'variables.set': false });
  });

  it('set rejects unknown --op operations', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'bogus.op=false'],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('set rejects malformed --op (no =)', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'secrets.set'],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('set without any --op / --category / --sensitivity errors', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('reset sends reset:true', async () => {
    await runCommand(['org-settings', 'dashboard-writes', 'reset', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      reset: true,
    });
  });
});
