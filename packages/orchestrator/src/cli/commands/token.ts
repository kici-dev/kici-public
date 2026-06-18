/**
 * Token management commands for kici-admin.
 *
 * Provides CRUD operations for admin API tokens:
 *   token create, list, revoke
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Format tokens as a table.
 */
function formatTokenTable(tokens: any[]): string {
  if (tokens.length === 0) return 'No tokens found.';

  const header = 'ID | Label | Role | RoutingKey | Created | LastUsed | Revoked';
  const sep = '-'.repeat(header.length);
  const rows = tokens.map((t: any) => {
    const id = t.id ?? '-';
    const label = t.label ?? '-';
    const role = t.role ?? '-';
    const rk = t.routingKey ?? t.routing_key ?? '-';
    const created = t.createdAt ?? t.created_at ?? '-';
    const lastUsed = t.lastUsedAt ?? t.last_used_at ?? '-';
    const revoked = t.revoked ?? false;
    return `${id} | ${label} | ${role} | ${rk} | ${created} | ${lastUsed} | ${revoked}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function registerTokenCommands(program: Command, getClient: () => AdminApiClient): void {
  const tok = program.command('token').description('Manage admin API tokens');

  tok
    .command('create <label>')
    .description('Create a new admin API token')
    .requiredOption('--role <role>', 'Token role (owner, admin, auditor)')
    .option(
      '--routing-key <key>',
      'Restrict the token to a single source routing key (e.g. "github:42"). The token can only act on requests targeting that routing key. Without this, the token has full orchestrator access.',
    )
    .action(async (label: string, opts: { role: string; routingKey?: string }) => {
      try {
        const result = await getClient().createToken({
          label,
          role: opts.role,
          routingKey: opts.routingKey,
        });
        console.log(`Token created: ${result.token}`);
        console.log(`Token ID: ${result.id}`);
        console.log('Save this token -- it will not be shown again.');
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tok
    .command('list')
    .description('List all admin API tokens')
    .action(async () => {
      try {
        const tokens = await getClient().listTokens();
        console.log(formatTokenTable(tokens));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tok
    .command('revoke <id>')
    .description('Revoke an admin API token')
    .action(async (id: string) => {
      try {
        await getClient().revokeToken(id);
        console.log(`Token ${id} revoked.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
