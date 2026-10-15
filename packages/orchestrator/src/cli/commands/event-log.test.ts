/**
 * Argument parsing and flag forwarding to the admin API client (including the
 * --action filter). The HTTP round trip needs a live orchestrator.
 */

import { describe, expect, it } from 'vitest';
import { registerEventLogCommands } from './event-log.js';
import type { AdminApiClient } from '../api-client.js';
import { runCli } from '../../__test-helpers__/cli.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  return runCli((p) => registerEventLogCommands(p, () => client as AdminApiClient), args);
}

describe('kici-admin event-log list --action', () => {
  it('forwards --action to the admin API client', async () => {
    const received: Array<Record<string, unknown>> = [];
    const client: Partial<AdminApiClient> = {
      listEventLog: async (opts) => {
        received.push(opts as Record<string, unknown>);
        return { deliveries: [], total: 0, limit: 50, offset: 0 };
      },
    };

    const { exitCode } = await runCommand(
      [
        'event-log',
        'list',
        '--event',
        'pull_request',
        '--action',
        'opened',
        '--limit',
        '1',
        '--json',
      ],
      client,
    );
    expect(exitCode).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0].action).toBe('opened');
    expect(received[0].event).toBe('pull_request');
  });

  it('emits JSON when --json is set', async () => {
    const response = {
      deliveries: [
        {
          orgId: 'o1',
          deliveryId: 'd1',
          routingKey: 'github:42',
          event: 'push',
          action: null,
          source: 'relay',
          provider: 'github',
          status: 'processed',
          matchedCount: 1,
          runId: null,
          receivedAt: '2024-01-01T00:00:00.000Z',
          payloadOmitted: false,
          payloadSizeBytes: 42,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const client: Partial<AdminApiClient> = {
      listEventLog: async () => response,
    };

    const { stdout, exitCode } = await runCommand(
      ['event-log', 'list', '--event', 'push', '--json'],
      client,
    );
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.deliveries).toHaveLength(1);
    expect(parsed.deliveries[0].deliveryId).toBe('d1');
  });
});
