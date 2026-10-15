/** `kici-admin workflow`; `list` goes through AdminApiClient and NEVER touches the DB. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AdminApiClient } from '../api-client.js';
import { runCli } from '../../__test-helpers__/cli.js';

// Lets register-manual tests supply an inline lock file.
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
  const getClient = () => client as AdminApiClient;
  return runCli((p) => registerWorkflowCommands(p, getClient), args);
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
      await runCommand(['workflow', 'list', '--org', 'acmeOrg00001', '--event', 'foo'], client);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const path = mockGet.mock.calls[0][0] as string;
      expect(path).toBe('/api/v1/admin/registrations?customerId=acmeOrg00001&event=foo');
    });

    it('W-2: --routing-key encodes the colon', async () => {
      await runCommand(['workflow', 'list', '--routing-key', 'github:42'], client);

      const path = mockGet.mock.calls[0][0] as string;
      expect(path).toBe('/api/v1/admin/registrations?routingKey=github%3A42');
    });

    it('W-3: --json prints the raw response and skips the table', async () => {
      const { stdout } = await runCommand(['workflow', 'list', '--json'], client);

      expect(stdout).toContain('"registrations"');
      expect(stdout).toContain('"reg-1"');
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
      // Param order is the implementation's; assert presence only.
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
          '--org',
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
          '--org',
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
          '--org',
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
          '--org',
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
