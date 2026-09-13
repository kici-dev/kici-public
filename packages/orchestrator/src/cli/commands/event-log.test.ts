/**
 * Tests for `kici-admin event-log` CLI subcommands.
 *
 * Covers flag forwarding to the admin API client (including the new --action
 * filter added for the E2E pollEventLog dogfooding refactor). Integration
 * coverage lives in the E2E suite against a live orchestrator.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerEventLogCommands } from './event-log.js';
import type { AdminApiClient } from '../api-client.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();
  registerEventLogCommands(program, () => client as AdminApiClient);

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
