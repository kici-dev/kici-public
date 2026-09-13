/**
 * Tests for `kici-admin workflow list` CLI subcommand.
 *
 * Verifies that the command:
 *  - Talks to /api/v1/admin/registrations via AdminApiClient (NEVER touches the DB)
 *  - Maps each --flag to the correct query string parameter
 *  - Renders a default table including column headers
 *  - Adds an org_id column when --org is omitted
 *  - Emits raw JSON when --json is supplied
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';

// Mock readFileSync so register-manual tests can supply an inline lock file
// without touching the filesystem.
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();
vi.mock('node:fs', async () => {
  return {
    readFileSync: (path: string, encoding: string) => mockReadFileSync(path, encoding),
  };
});

const mockRegisterWorkflowManualDirect = vi.fn();
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    registerWorkflowManualDirect: mockRegisterWorkflowManualDirect,
  };
});

const { registerWorkflowCommands } = await import('./workflow.js');

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const sampleRegistration = {
  id: 'reg-1',
  customerId: 'orgA',
  routing_key: 'github:42',
  repo_identifier: 'owner/repo',
  workflow_name: 'ci',
  trigger_types: ['webhook'],
  lock_entry: {
    name: 'ci',
    triggers: [{ _type: 'webhook', events: ['foo', 'bar'] }],
    jobs: [],
  },
  provider_context: {},
  disabled: false,
  isGlobal: false,
  commitSha: null,
  sourceFile: null,
  created_at: '2026-04-07T00:00:00Z',
  updated_at: '2026-04-07T00:00:00Z',
};

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();

  const getClient = () => client as AdminApiClient;
  registerWorkflowCommands(program, getClient);

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
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      if (err.code?.startsWith('commander.'))
        return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
}

describe('kici-admin workflow CLI commands', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn().mockResolvedValue({ registrations: [sampleRegistration], total: 1 });
    client = { get: mockGet as any };
  });

  describe('workflow list', () => {
    it('W-1: --org and --event build the right query string', async () => {
      await runCommand(['workflow', 'list', '--org', 'kiciStg00001', '--event', 'foo'], client);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const path = mockGet.mock.calls[0][0] as string;
      expect(path).toBe('/api/v1/admin/registrations?customerId=kiciStg00001&event=foo');
    });

    it('W-2: --routing-key encodes the colon', async () => {
      await runCommand(['workflow', 'list', '--routing-key', 'github:42'], client);

      const path = mockGet.mock.calls[0][0] as string;
      expect(path).toBe('/api/v1/admin/registrations?routingKey=github%3A42');
    });

    it('W-3: --json prints the raw response and skips the table', async () => {
      const { stdout } = await runCommand(['workflow', 'list', '--json'], client);

      // Must contain the JSON serialization of the response
      expect(stdout).toContain('"registrations"');
      expect(stdout).toContain('"reg-1"');
      // Must NOT include the table header divider style
      expect(stdout).not.toMatch(/^id\s+repo_identifier/m);
    });

    it('W-4: default call uses no query string and renders a table with headers', async () => {
      const { stdout } = await runCommand(['workflow', 'list'], client);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/registrations');
      expect(stdout).toContain('id');
      expect(stdout).toContain('repo_identifier');
      expect(stdout).toContain('workflow_name');
      expect(stdout).toContain('trigger_types');
      expect(stdout).toContain('events');
      expect(stdout).toContain('disabled');
    });

    it('W-5: without --org the table includes an org_id column', async () => {
      const { stdout } = await runCommand(['workflow', 'list'], client);

      expect(stdout).toContain('org_id');
      expect(stdout).toContain('orgA');
    });

    it('W-5b: with --org the org_id column is suppressed', async () => {
      const { stdout } = await runCommand(['workflow', 'list', '--org', 'orgA'], client);

      expect(stdout).not.toContain('org_id');
    });

    it('W-6: --trigger-type and --event are combined in the query string', async () => {
      await runCommand(['workflow', 'list', '--trigger-type', 'webhook', '--event', 'foo'], client);

      const path = mockGet.mock.calls[0][0] as string;
      // Order is determined by the implementation; assert on substring presence.
      expect(path.startsWith('/api/v1/admin/registrations?')).toBe(true);
      expect(path).toContain('triggerType=webhook');
      expect(path).toContain('event=foo');
    });
  });

  describe('workflow register-manual', () => {
    const lockFileJson = JSON.stringify({
      workflows: [
        {
          name: 'ci',
          triggers: [{ _type: 'push', repos: ['owner/repo'] }],
          jobs: [],
        },
      ],
    });

    beforeEach(() => {
      mockReadFileSync.mockReturnValue(lockFileJson);
      mockRegisterWorkflowManualDirect.mockResolvedValue({
        workflowCount: 1,
        registryVersion: 3,
      });
    });

    it('RM-1: direct-DB mode calls registerWorkflowManualDirect with parsed args', async () => {
      const { stdout, exitCode } = await runCommand(
        [
          'workflow',
          'register-manual',
          '--lock-file',
          '/tmp/kici.lock.json',
          '--repo',
          'owner/repo',
          '--routing-key',
          'github:42',
          '--customer',
          'orgA',
          '--provider-context',
          '{"installationId":42}',
          '--commit-sha',
          'abc123',
          '--database-url',
          'postgres://x',
        ],
        client,
      );
      expect(exitCode).toBeNull();
      expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/kici.lock.json', 'utf-8');
      expect(mockRegisterWorkflowManualDirect).toHaveBeenCalledWith('postgres://x', {
        lockFileContents: lockFileJson,
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
        customerId: 'orgA',
        providerContext: { installationId: 42 },
        commitSha: 'abc123',
      });
      expect(stdout).toContain('workflowCount=1');
      expect(stdout).toContain('registryVersion=3');
      expect(stdout).toContain('(direct)');
    });

    it('RM-2: HTTP mode posts to /api/v1/admin/registrations/register-manual', async () => {
      const mockPost = vi.fn().mockResolvedValue({ workflowCount: 2, registryVersion: 7 });
      const clientWithPost: Partial<AdminApiClient> = {
        ...client,
        post: mockPost as any,
      };
      const { stdout, exitCode } = await runCommand(
        [
          'workflow',
          'register-manual',
          '--lock-file',
          '/tmp/kici.lock.json',
          '--repo',
          'owner/repo',
          '--routing-key',
          'github:42',
          '--customer',
          'orgA',
        ],
        clientWithPost,
      );
      expect(exitCode).toBeNull();
      expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/registrations/register-manual', {
        lockFileContents: lockFileJson,
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
        customerId: 'orgA',
        providerContext: {},
        commitSha: undefined,
      });
      expect(stdout).toContain('workflowCount=2');
      expect(stdout).toContain('registryVersion=7');
      expect(stdout).not.toContain('(direct)');
    });

    it('RM-3: --json emits machine-parseable output', async () => {
      const { stdout } = await runCommand(
        [
          'workflow',
          'register-manual',
          '--lock-file',
          '/tmp/kici.lock.json',
          '--repo',
          'owner/repo',
          '--routing-key',
          'github:42',
          '--customer',
          'orgA',
          '--database-url',
          'postgres://x',
          '--json',
        ],
        client,
      );
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ workflowCount: 1, registryVersion: 3 });
    });

    it('RM-4: --provider-context rejects non-object JSON with a clear error', async () => {
      const { stderr, exitCode } = await runCommand(
        [
          'workflow',
          'register-manual',
          '--lock-file',
          '/tmp/kici.lock.json',
          '--repo',
          'owner/repo',
          '--routing-key',
          'github:42',
          '--customer',
          'orgA',
          '--provider-context',
          '[1,2,3]',
          '--database-url',
          'postgres://x',
        ],
        client,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--provider-context');
    });
  });
});
