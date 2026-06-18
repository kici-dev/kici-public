/**
 * Platform API key management commands for kici-admin.
 *
 * These commands target the Platform admin API for managing API keys
 * and routing key permissions. Uses the same --url flag (point to Platform URL).
 *
 *   api-key create, add-routing-key
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

export function registerApiKeyCommands(program: Command, getClient: () => AdminApiClient): void {
  const apiKey = program
    .command('api-key')
    .description('Manage Platform API keys and routing keys');

  apiKey
    .command('create')
    .description('Create a new API key with optional routing key permissions')
    .option('--label <label>', 'Label for the API key', 'unnamed')
    .option(
      '--routing-keys <keys>',
      'Comma-separated routing key patterns (e.g. github:42,github:99)',
    )
    .action(async (opts: { label: string; routingKeys?: string }) => {
      try {
        const routingKeys = opts.routingKeys
          ? opts.routingKeys.split(',').map((k) => k.trim())
          : undefined;
        const result = await getClient().createApiKey({
          label: opts.label,
          routingKeys,
        });
        console.log(`API key created successfully.`);
        console.log(`Key ID: ${result.id}`);
        console.log(`Key:    ${result.key}`);
        if (result.routingKeys?.length) {
          console.log(`Routing keys: ${result.routingKeys.join(', ')}`);
        }
        console.log('');
        console.log('WARNING: Save this key now -- it cannot be recovered after this point.');
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  apiKey
    .command('add-routing-key <id> <pattern>')
    .description('Add a routing key permission pattern to an API key')
    .action(async (id: string, pattern: string) => {
      try {
        const result = await getClient().addRoutingKeyPermission(id, pattern);
        console.log(`Routing key permission added.`);
        console.log(`Permission ID: ${result.id}`);
        console.log(`Pattern:       ${result.pattern}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
