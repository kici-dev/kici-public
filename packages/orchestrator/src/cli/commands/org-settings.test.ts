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
import { DASHBOARD_WRITE_OPERATIONS } from '@kici-dev/engine/protocol/dashboard-write-operations';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const ORG = 'acmeOrg00001';

const SAMPLE_SETTINGS = {
  customerId: ORG,
  enabled: true,
  allowedRepos: [{ pattern: 'myorg/ci-*' }],
  deniedRepos: null,
  allowHttpNpmRegistries: false,
  userCacheQuotaBytes: null,
  userCacheTtlMs: null,
  artifactMaxBytes: null,
  artifactMaxPerRun: null,
  rerouteSpawnMaxAttempts: null,
  rerouteSpawnRetryBackoffMs: null,
  cacheUploadSettleTimeoutMs: null,
  sandboxAllowedCapabilities: [],
  sandboxAllowHostNetwork: false,
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
        exitCode = err.exitCode ?? 1;
        errors.push(err.message);
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
      ['org-settings', 'global-workflows', 'show', '--org', ORG, '--format', 'json'],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
    expect(JSON.parse(stdout)).toEqual(SAMPLE_SETTINGS);
  });

  it('show defaults to a human-readable table', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--org', ORG],
      client,
    );
    expect(stdout).toContain('Customer/org id:');
    expect(stdout).toContain(ORG);
    expect(stdout).toContain('Enabled (cluster-wide):');
    expect(stdout).toContain('Allowed authors:');
    expect(stdout).toContain('Denied source repos:');
    // fails-when: the removed elevated-access list is rendered again.
    expect(stdout).not.toContain('Elevated');
  });

  it('rejects --customer-id as an unknown option', async () => {
    // fails-when: the --customer-id spelling is still registered.
    const result = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--org', ORG, '--customer-id', ORG],
      client,
    );
    expect(result.exitCode).not.toBeNull();
    expect(result.stderr).toMatch(/unknown option '--customer-id'/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('requires --org', async () => {
    // breaks-if-wrong: dropping the alias must not leave the org optional.
    const result = await runCommand(['org-settings', 'global-workflows', 'show'], client);
    expect(result.stderr).toMatch(/required option '--org <id>' not specified/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('set-enabled is gone — the master switch is cluster-wide', async () => {
    // The subcommand was removed with the per-org master switch. The point is
    // that nothing patches the org row any more; commander reports the removed
    // subcommand as an unknown command (exit non-zero, never 0).
    const { exitCode } = await runCommand(
      ['org-settings', 'global-workflows', 'set-enabled', 'true', '--org', ORG],
      client,
    );
    expect(mockPatch).not.toHaveBeenCalled();
    expect(exitCode).not.toBe(0);
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
      ['org-settings', 'global-workflows', 'allow-add', 'myorg/deploy', '--org', ORG],
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
        '--org',
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
      ['org-settings', 'global-workflows', 'allow-add', 'myorg/ci-*', '--org', ORG],
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
        '--org',
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
      ['org-settings', 'global-workflows', 'deny-remove', 'b', '--org', ORG],
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
        '--org',
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
    const genericKey = 'generic:acmeOrg00001:src-abc';
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
        '--org',
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

  // fails-when: the elevate-add / elevate-remove mutators are registered
  //   again. The list they edited granted nothing: an organization-wide
  //   workflow's job is dispatched with no secret material.
  it.each(['elevate-add', 'elevate-remove'])('%s is an unknown command', async (sub) => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerOrgSettingsCommands(program, () => client as AdminApiClient);
    await expect(
      program.parseAsync(['org-settings', 'global-workflows', sub, 'myorg/release', '--org', ORG], {
        from: 'user',
      }),
    ).rejects.toThrow(/unknown command 'elevate-(add|remove)'/);
    expect(mockPatch).not.toHaveBeenCalled();
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
      ['org-settings', 'user-cache', 'show', '--org', ORG],
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
      ['org-settings', 'user-cache', 'set-quota', '1073741824', '--org', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      userCacheQuotaBytes: 1073741824,
    });
  });

  it('set-ttl patches userCacheTtlMs with a positive integer', async () => {
    await runCommand(['org-settings', 'user-cache', 'set-ttl', '3600000', '--org', ORG], client);
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
      ['org-settings', 'user-cache', 'set-quota', '0', '--org', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('positive integer');
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('kici-admin org-settings artifacts', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show prints the per-org size cap + per-run cap (cluster default when null)', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'artifacts', 'show', '--org', ORG],
      client,
    );
    expect(stdout).toContain('Artifact max bytes:');
    expect(stdout).toContain('Artifact max/run:');
    expect(stdout).toContain('(cluster default)');
  });

  it('set-max-bytes patches artifactMaxBytes with a positive integer', async () => {
    await runCommand(
      ['org-settings', 'artifacts', 'set-max-bytes', '2147483648', '--org', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      artifactMaxBytes: 2147483648,
    });
  });

  it('set-max-per-run patches artifactMaxPerRun with a positive integer', async () => {
    await runCommand(['org-settings', 'artifacts', 'set-max-per-run', '3', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      artifactMaxPerRun: 3,
    });
  });

  it('reset-max-bytes patches artifactMaxBytes to null (cluster default)', async () => {
    await runCommand(['org-settings', 'artifacts', 'reset-max-bytes', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      artifactMaxBytes: null,
    });
  });

  it('reset-max-per-run patches artifactMaxPerRun to null (cluster default)', async () => {
    await runCommand(['org-settings', 'artifacts', 'reset-max-per-run', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      artifactMaxPerRun: null,
    });
  });

  it('set-max-per-run rejects a non-positive / non-integer value with exit 1', async () => {
    const { exitCode, stderr } = await runCommand(
      ['org-settings', 'artifacts', 'set-max-per-run', '0', '--org', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('positive integer');
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('kici-admin org-settings reroute', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show fetches the settings', async () => {
    await runCommand(['org-settings', 'reroute', 'show', '--org', ORG], client);
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
  });

  it('set patches only the flags provided', async () => {
    await runCommand(
      ['org-settings', 'reroute', 'set', '--org', ORG, '--window', '120000', '--max-hops', '5'],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      rerouteSpawnWindowMs: 120000,
      rerouteMaxHops: 5,
    });
  });

  it('set with no flags exits 1', async () => {
    const { exitCode, stderr } = await runCommand(
      ['org-settings', 'reroute', 'set', '--org', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('at least one of');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('set rejects a window below the 1000ms floor', async () => {
    const { exitCode } = await runCommand(
      ['org-settings', 'reroute', 'set', '--org', ORG, '--window', '500'],
      client,
    );
    expect(exitCode).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('reset clears every reroute override, the spawn-retry budget included', async () => {
    // fails-when: reset leaves the spawn-retry overrides in place on a current orchestrator
    mockGet.mockResolvedValue({
      settings: {
        ...SAMPLE_SETTINGS,
        rerouteSpawnMaxAttempts: 2,
        rerouteSpawnRetryBackoffMs: null,
      },
    });
    await runCommand(['org-settings', 'reroute', 'reset', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      rerouteSpawnWindowMs: null,
      rerouteAckTimeoutMs: null,
      rerouteMaxHops: null,
      rerouteSpawnMaxAttempts: null,
      rerouteSpawnRetryBackoffMs: null,
    });
  });

  it('set patches the spawn-retry budget flags', async () => {
    await runCommand(
      [
        'org-settings',
        'reroute',
        'set',
        '--org',
        ORG,
        '--spawn-max-attempts',
        '2',
        '--spawn-retry-backoff',
        '0',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      rerouteSpawnMaxAttempts: 2,
      rerouteSpawnRetryBackoffMs: 0,
    });
  });

  it('set rejects a spawn budget below its floors', async () => {
    for (const flags of [
      ['--spawn-max-attempts', '0'],
      ['--spawn-retry-backoff', '-1'],
    ]) {
      // fails-when: a floor is dropped, so a worker could be told to never spawn
      const { exitCode } = await runCommand(
        ['org-settings', 'reroute', 'set', '--org', ORG, ...flags],
        client,
      );
      expect(exitCode).toBe(1);
    }
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('show prints the spawn-retry budget lines', async () => {
    mockGet.mockResolvedValue({
      settings: {
        ...SAMPLE_SETTINGS,
        rerouteSpawnMaxAttempts: 4,
        rerouteSpawnRetryBackoffMs: 2500,
      },
    });
    const { stdout } = await runCommand(['org-settings', 'reroute', 'show', '--org', ORG], client);
    expect(stdout).toContain('Reroute spawn attempts: 4');
    expect(stdout).toContain('Reroute spawn backoff: 2500 ms');
  });

  it('show prints the cluster default when the budget is unset', async () => {
    const { stdout } = await runCommand(['org-settings', 'reroute', 'show', '--org', ORG], client);
    expect(stdout).toContain('Reroute spawn attempts: (cluster default)');
    expect(stdout).toContain('Reroute spawn backoff: (cluster default)');
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
    platformManaged: false,
  };
  const DW_RESPONSE = {
    ...DW_RESPONSE_EMPTY,
    // The server reports a state for every operation it knows.
    states: Object.fromEntries(DASHBOARD_WRITE_OPERATIONS.map((d) => [d.name, 'permissive'])),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue(DW_RESPONSE);
    mockPatch = vi.fn().mockResolvedValue(DW_RESPONSE);
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
    expect(JSON.parse(result.stdout)).toEqual(DW_RESPONSE);
  });

  it('show table mode groups operations by category', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'show', '--org', ORG],
      client,
    );
    expect(result.stdout).toContain('SECRETS');
    expect(result.stdout).toContain('secrets.set');
    expect(result.stdout).toContain('permissive');
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
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'secrets.set=disabled'],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      updates: { 'secrets.set': 'disabled' },
    });
  });

  it('rejects the boolean sugar --op name=true', async () => {
    // fails-when: true/false still maps to permissive/disabled.
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'secrets.set=true'],
      client,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--op value must be one of permissive\|encrypted\|disabled/);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('set --op secrets.set=encrypted sends the encrypted posture', async () => {
    await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'secrets.set=encrypted'],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      updates: { 'secrets.set': 'encrypted' },
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
        'secrets.set=disabled',
        '--op',
        'variables.set=disabled',
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/dashboard-writes', {
      customerId: ORG,
      updates: { 'secrets.set': 'disabled', 'variables.set': 'disabled' },
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
    expect(body.updates['secrets.set']).toBe('disabled');
    expect(body.updates['secrets.delete']).toBe('disabled');
    expect(body.updates['secrets.scope.create']).toBe('disabled');
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
    expect(body.updates).toEqual({ 'secrets.set': 'disabled', 'variables.set': 'disabled' });
  });

  it('set rejects unknown --op operations', async () => {
    const result = await runCommand(
      ['org-settings', 'dashboard-writes', 'set', '--org', ORG, '--op', 'bogus.op=disabled'],
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

  // A policy set before the server-side refusal existed can still hold this
  // state, and the operator has no other way to discover it: the row reads as
  // an ordinary disable, and the answering surface it removed is elsewhere.
  describe('already-disabled held-run lockout', () => {
    const lockedOut = (platformManaged: boolean) => ({
      ...DW_RESPONSE,
      stored: { 'held_runs.approve': 'disabled' },
      effective: { ...DW_RESPONSE_EMPTY.effective, 'held_runs.approve': false },
      states: { ...DW_RESPONSE.states, 'held_runs.approve': 'disabled' },
      platformManaged,
    });

    it('warns when a Platform is attached, naming the way back', async () => {
      mockGet.mockResolvedValue(lockedOut(true));
      const result = await runCommand(
        ['org-settings', 'dashboard-writes', 'show', '--org', ORG],
        client,
      );
      expect(result.stdout).toContain('WARNING');
      expect(result.stdout).toContain('held_runs.approve');
      expect(result.stdout).toContain('--op held_runs.approve=permissive');
    });

    // The positive control: identical policy, independent mode. There
    // `kici-admin held-run approve` answers holds, so the disable is coherent.
    it('stays quiet on an independent orchestrator', async () => {
      mockGet.mockResolvedValue(lockedOut(false));
      const result = await runCommand(
        ['org-settings', 'dashboard-writes', 'show', '--org', ORG],
        client,
      );
      expect(result.stdout).not.toContain('WARNING');
    });

    it('stays quiet when no held-run write is disabled', async () => {
      mockGet.mockResolvedValue({ ...DW_RESPONSE, platformManaged: true });
      const result = await runCommand(
        ['org-settings', 'dashboard-writes', 'show', '--org', ORG],
        client,
      );
      expect(result.stdout).not.toContain('WARNING');
    });
  });
});

describe('kici-admin org-settings sandbox-allowlist', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({
      settings: {
        ...SAMPLE_SETTINGS,
        sandboxAllowedCapabilities: ['NET_ADMIN'],
        sandboxAllowHostNetwork: true,
      },
    });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show prints the capability list + host-network flag', async () => {
    const { stdout } = await runCommand(
      ['org-settings', 'sandbox-allowlist', 'show', '--org', ORG],
      client,
    );
    expect(stdout).toContain('Sandbox capabilities:');
    expect(stdout).toContain('NET_ADMIN');
    expect(stdout).toContain('Sandbox host network:  true');
  });

  it('set-capabilities patches a parsed, comma-separated list', async () => {
    await runCommand(
      [
        'org-settings',
        'sandbox-allowlist',
        'set-capabilities',
        'NET_ADMIN, SYS_PTRACE',
        '--org',
        ORG,
      ],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      sandboxAllowedCapabilities: ['NET_ADMIN', 'SYS_PTRACE'],
    });
  });

  it('set-capabilities with an empty string clears the list', async () => {
    await runCommand(
      ['org-settings', 'sandbox-allowlist', 'set-capabilities', '', '--org', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      sandboxAllowedCapabilities: [],
    });
  });

  it('allow-host-network true patches the flag', async () => {
    await runCommand(
      ['org-settings', 'sandbox-allowlist', 'allow-host-network', 'true', '--org', ORG],
      client,
    );
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      sandboxAllowHostNetwork: true,
    });
  });

  it('allow-host-network rejects a non-boolean with exit 1', async () => {
    const { exitCode, stderr } = await runCommand(
      ['org-settings', 'sandbox-allowlist', 'allow-host-network', 'maybe', '--org', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be "true" or "false"');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('reset clears both the capability list and host-network flag', async () => {
    await runCommand(['org-settings', 'sandbox-allowlist', 'reset', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      sandboxAllowedCapabilities: null,
      sandboxAllowHostNetwork: false,
    });
  });
});

describe('kici-admin org-settings cache-upload-settle', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: mockGet as any, patch: mockPatch as any };
  });

  it('show fetches the settings and renders a missing field as the cluster default', async () => {
    // SAMPLE_SETTINGS has no cacheUploadSettleTimeoutMs — an older orchestrator.
    const { stdout } = await runCommand(
      ['org-settings', 'cache-upload-settle', 'show', '--org', ORG],
      client,
    );
    expect(mockGet).toHaveBeenCalledWith(
      `/api/v1/admin/org-settings/global-workflows?customerId=${encodeURIComponent(ORG)}`,
    );
    expect(stdout).toMatch(/Cache upload settle:\s+\(cluster default\)/);
  });

  it('set patches cacheUploadSettleTimeoutMs', async () => {
    await runCommand(['org-settings', 'cache-upload-settle', 'set', '5000', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      cacheUploadSettleTimeoutMs: 5000,
    });
  });

  it('set accepts 0 (no wait)', async () => {
    await runCommand(['org-settings', 'cache-upload-settle', 'set', '0', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      cacheUploadSettleTimeoutMs: 0,
    });
  });

  it('set rejects a non-integer with exit 1 and sends nothing', async () => {
    // fails-when: the CLI forwards an invalid value.
    const { exitCode } = await runCommand(
      ['org-settings', 'cache-upload-settle', 'set', '1.5', '--org', ORG],
      client,
    );
    expect(exitCode).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('reset clears the override to null', async () => {
    await runCommand(['org-settings', 'cache-upload-settle', 'reset', '--org', ORG], client);
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
      customerId: ORG,
      cacheUploadSettleTimeoutMs: null,
    });
  });
});

/**
 * Every per-org integer knob: `set` patches its field, a value below the floor
 * exits 1 with the knob's own message and sends nothing, a failed PATCH prints
 * the server error, and `reset` patches the field to null.
 */
describe('kici-admin org-settings integer knobs', () => {
  interface KnobCase {
    name: string;
    set: (value: string) => string[];
    reset: string[];
    field: string;
    min: number;
    invalid: string;
  }
  const valueArg =
    (...cmd: string[]) =>
    (value: string) => ['org-settings', ...cmd, value];
  const cases: KnobCase[] = [
    {
      name: 'backup-freshness',
      set: (v) => ['org-settings', 'backup-freshness', 'set', '--hours', v],
      reset: ['org-settings', 'backup-freshness', 'reset'],
      field: 'backupStalenessWarnHours',
      min: 1,
      invalid: 'Error: --hours must be an integer >= 1',
    },
    {
      name: 'queue-timeout',
      set: valueArg('queue-timeout', 'set'),
      reset: ['org-settings', 'queue-timeout', 'reset'],
      field: 'queueTimeoutMs',
      min: 0,
      invalid: 'Error: --ms must be an integer >= 0',
    },
    {
      name: 'cache-upload-settle',
      set: valueArg('cache-upload-settle', 'set'),
      reset: ['org-settings', 'cache-upload-settle', 'reset'],
      field: 'cacheUploadSettleTimeoutMs',
      min: 0,
      invalid: 'Error: --ms must be an integer >= 0',
    },
    {
      name: 'dispatch-ack',
      set: valueArg('dispatch-ack', 'set'),
      reset: ['org-settings', 'dispatch-ack', 'reset'],
      field: 'dispatchAckTimeoutMs',
      min: 1000,
      invalid: 'Error: value must be an integer >= 1000 (milliseconds)',
    },
    {
      name: 'scaler-spawn-timeout',
      set: valueArg('scaler-spawn-timeout', 'set'),
      reset: ['org-settings', 'scaler-spawn-timeout', 'reset'],
      field: 'scalerSpawnTimeoutMs',
      min: 1000,
      invalid: 'Error: value must be an integer >= 1000 (milliseconds)',
    },
    {
      name: 'ingest-concurrency',
      set: valueArg('ingest-concurrency', 'set'),
      reset: ['org-settings', 'ingest-concurrency', 'reset'],
      field: 'ingestMaxConcurrency',
      min: 1,
      invalid: 'Error: value must be an integer >= 1',
    },
    ...(
      [
        ['user-cache', 'quota', 'userCacheQuotaBytes', 'bytes'],
        ['user-cache', 'ttl', 'userCacheTtlMs', 'milliseconds'],
        ['artifacts', 'quota', 'artifactQuotaBytes', 'bytes'],
        ['artifacts', 'ttl', 'artifactTtlMs', 'milliseconds'],
        ['artifacts', 'max-bytes', 'artifactMaxBytes', 'bytes'],
        ['artifacts', 'max-per-run', 'artifactMaxPerRun', 'artifacts'],
      ] as const
    ).map(([group, knob, field, unit]) => ({
      name: `${group} ${knob}`,
      set: valueArg(group, `set-${knob}`),
      reset: ['org-settings', group, `reset-${knob}`],
      field,
      min: 1,
      invalid: `Error: value must be a positive integer (${unit})`,
    })),
  ];

  let mockPatch: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch = vi.fn().mockResolvedValue({ settings: SAMPLE_SETTINGS });
    client = { get: vi.fn() as any, patch: mockPatch as any };
  });

  describe.each(cases)('$name', (c) => {
    it('set at the floor patches the field and prints the settings', async () => {
      const result = await runCommand([...c.set(String(c.min)), '--org', ORG], client);
      expect(result.exitCode).toBeNull();
      expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
        customerId: ORG,
        [c.field]: c.min,
      });
      expect(result.stdout).toContain(`Customer/org id:       ${ORG}`);
    });

    // fails-when: the knob accepts a value below its floor, or its message changes.
    it('set below the floor exits 1 with the knob message and sends nothing', async () => {
      const result = await runCommand([...c.set(String(c.min - 1)), '--org', ORG], client);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(c.invalid);
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('set prints the server error and exits 1 when the PATCH fails', async () => {
      mockPatch.mockRejectedValueOnce(new Error('boom'));
      const result = await runCommand([...c.set(String(c.min)), '--org', ORG], client);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('Error: boom');
    });

    it('reset patches the field to null', async () => {
      const result = await runCommand([...c.reset, '--org', ORG], client);
      expect(result.exitCode).toBeNull();
      expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/org-settings/global-workflows', {
        customerId: ORG,
        [c.field]: null,
      });
    });
  });
});

describe('kici-admin org-settings show against an orchestrator that omits newer fields', () => {
  // fails-when: the table renders an absent nullable field as `undefined`, or an
  // absent capability list crashes the command.
  it('renders every absent override as the cluster default', async () => {
    const { customerId, enabled, allowedRepos, deniedRepos } = SAMPLE_SETTINGS;
    const client: Partial<AdminApiClient> = {
      get: vi.fn().mockResolvedValue({
        settings: { customerId, enabled, allowedRepos, deniedRepos },
      }) as any,
    };
    const result = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--org', ORG],
      client,
    );
    expect(result.exitCode).toBeNull();
    expect(result.stdout).not.toContain('undefined');
    expect(result.stdout).toMatch(/Approval expiry:\s+\(not reported\)/);
    expect(result.stdout).toMatch(/Allow self-approval:\s+\(not reported\)/);
    expect(result.stdout).toMatch(/Artifact max\/run:\s+\(cluster default\)/);
    expect(result.stdout).toMatch(/Reroute max hops:\s+\(cluster default\)/);
    expect(result.stdout).toMatch(/Dispatch ack timeout:\s+\(cluster default\)/);
    expect(result.stdout).toMatch(/Ingest max concurrency: \(cluster default\)/);
    expect(result.stdout).toMatch(/Queue timeout:\s+\(cluster default\)/);
    expect(result.stdout).toMatch(/Sandbox capabilities:\s+\(none — deny all\)/);
  });

  // breaks-if-wrong: a set override must still render its value and unit.
  it('still renders a set override and a reported value with its unit', async () => {
    const client: Partial<AdminApiClient> = {
      get: vi.fn().mockResolvedValue({
        settings: {
          ...SAMPLE_SETTINGS,
          dispatchAckTimeoutMs: 0,
          ingestMaxConcurrency: 4,
          approvalExpirySeconds: 86400,
        },
      }) as any,
    };
    const result = await runCommand(
      ['org-settings', 'global-workflows', 'show', '--org', ORG],
      client,
    );
    expect(result.stdout).toMatch(/Dispatch ack timeout:\s+0 ms/);
    expect(result.stdout).toContain('Ingest max concurrency: 4');
    expect(result.stdout).toMatch(/Approval expiry:\s+\d+ s/);
    expect(result.stdout).toContain('Allow http registries: false');
  });
});
