/**
 * Argument parsing and forwarding of the agent-attribution filters
 * (--agent-label / --agent-only); the HTTP round trip needs a live orchestrator.
 */

import { describe, expect, it } from 'vitest';
import { registerAccessLogCommands } from './access-log.js';
import type { AdminApiClient } from '../api-client.js';
import { runCli } from '../../__test-helpers__/cli.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  return runCli((p) => registerAccessLogCommands(p, () => client as AdminApiClient), args);
}

describe('kici-admin access-log list agent filters', () => {
  it('forwards --agent-label to the admin API client', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      listAccessLog: async (opts) => {
        received.push(opts as Record<string, unknown>);
        return { items: [], nextCursor: null };
      },
    };

    await runCommand(['access-log', 'list', '--agent-label', 'cc'], client);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ agentLabel: 'cc' });
  });

  it('forwards --agent-only as agentOnly: true', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      listAccessLog: async (opts) => {
        received.push(opts as Record<string, unknown>);
        return { items: [], nextCursor: null };
      },
    };

    await runCommand(['access-log', 'list', '--agent-only'], client);

    expect(received).toHaveLength(1);
    expect(received[0]!.agentOnly).toBe(true);
  });

  it('renders the agent column with the row agentLabel', async () => {
    const client: Partial<AdminApiClient> = {
      listAccessLog: async () => ({
        items: [
          {
            id: 'row-1',
            orgId: 'org-1',
            routingKey: null,
            actorType: 'api_key',
            actorId: 'key-1',
            actorMeta: null,
            action: 'run.detail.read',
            targetType: 'run',
            targetId: 'run-1',
            requestId: null,
            source: 'platform_proxy',
            outcome: 'allowed',
            errorMessage: null,
            agentLabel: 'claude-code',
            createdAt: '2026-06-30T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    };

    const { stdout } = await runCommand(['access-log', 'list'], client);
    expect(stdout).toContain('agent');
    expect(stdout).toContain('claude-code');
  });
});
