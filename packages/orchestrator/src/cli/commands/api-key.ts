/**
 * `kici-admin api-key` — deprecated.
 *
 * The group targeted `/api/v1/api-keys`, which no KiCI server serves, so it
 * never worked. Both subcommands stay registered until v1.0.0 and exit with a
 * message that points at `kici-admin token create`, the per-person
 * orchestrator token a developer passes to `kici connect`.
 *
 *   api-key create, add-routing-key
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { cliAction } from './shared/cli-action.js';

export const API_KEY_DEPRECATED_MESSAGE =
  'kici-admin api-key is deprecated and has no effect: no KiCI server serves /api/v1/api-keys. ' +
  'Mint a per-person orchestrator token instead: kici-admin token create <label> --role admin --subject <who> --expires <duration>. ' +
  'This command is removed in v1.0.0.';

const DEPRECATED_DESCRIPTION = 'Deprecated: use kici-admin token create (removed in v1.0.0)';

/**
 * Register the deprecated `api-key` group. `getClient` is accepted for the
 * registration signature every command group shares and is never called.
 */
export function registerApiKeyCommands(program: Command, _getClient: () => AdminApiClient): void {
  const apiKey = program.command('api-key').description(DEPRECATED_DESCRIPTION);

  apiKey
    .command('create')
    .description(DEPRECATED_DESCRIPTION)
    .option('--label <label>', 'Ignored', 'unnamed')
    .option('--routing-keys <keys>', 'Ignored')
    .action(
      cliAction(async () => {
        throw new Error(API_KEY_DEPRECATED_MESSAGE);
      }),
    );

  apiKey
    .command('add-routing-key <id> <pattern>')
    .description(DEPRECATED_DESCRIPTION)
    .action(
      cliAction(async () => {
        throw new Error(API_KEY_DEPRECATED_MESSAGE);
      }),
    );
}
