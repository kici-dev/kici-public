/**
 * Tests for `kici-admin access-log` CLI subcommands.
 *
 * Covers flag forwarding to the admin API client for the agent-attribution
 * filters (--agent-label / --agent-only). Integration coverage lives in the
 * E2E suite against a live orchestrator.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerAccessLogCommands } from './access-log.js';
import type { AdminApiClient } from '../api-client.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();
  registerAccessLogCommands(program, () => client as AdminApiClient);

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
