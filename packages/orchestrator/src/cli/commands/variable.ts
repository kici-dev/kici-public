/**
 * Environment variable management commands for kici-admin.
 *
 *   kici-admin variable list   <orgId> <environment>
 *   kici-admin variable get    <orgId> <environment> <key>
 *   kici-admin variable set    <orgId> <environment> <key> [--value | --from-stdin | --from-file | --from-env | --prompt]
 *   kici-admin variable delete <orgId> <environment> <key>
 *
 * Org-level environment variables are plaintext-at-rest in the
 * orchestrator's DB; the dashboard write path is gated by the
 * `variables.set` / `variables.delete` switches in the dashboard-write
 * policy. This CLI is the always-available authority path when the
 * dashboard is disabled for either switch.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import { resolveSecretInput, fingerprintValue } from './shared/secret-input.js';

export function registerVariableCommands(program: Command, getClient: () => AdminApiClient): void {
  const vr = program.command('variable').description('Manage environment variables');

  vr.command('list <orgId> <environment>')
    .description('List org-level variables in an environment')
    .option('--values', 'Print variable values inline (default: keys + locked flag only)')
    .action(async (orgId: string, environment: string, opts: { values?: boolean }) => {
      try {
        const { variables } = await getClient().listVariables(orgId, environment);
        if (variables.length === 0) {
          console.log('No variables in this environment.');
          return;
        }
        for (const v of variables) {
          const lockTag = v.locked ? ' [locked]' : '';
          if (opts.values) {
            console.log(`  - ${v.key}=${v.value}${lockTag}`);
          } else {
            console.log(`  - ${v.key}${lockTag}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  vr.command('get <orgId> <environment> <key>')
    .description('Print the value of a single variable')
    .action(async (orgId: string, environment: string, key: string) => {
      try {
        const { variables } = await getClient().listVariables(orgId, environment);
        const match = variables.find((v) => v.key === key);
        if (!match) {
          console.error(`Variable '${key}' not found in environment '${environment}'.`);
          process.exit(1);
        }
        console.log(match.value);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  vr.command('set <orgId> <environment> <key>')
    .description(
      'Set an environment variable. Value comes from one of: --prompt (default on TTY), ' +
        '--from-stdin (default on pipe), --from-file <path>, --from-env <VAR>, ' +
        '--value <plaintext> (discouraged).',
    )
    .option('--value <value>', 'Variable value via argv (visible in shell history)')
    .option('--prompt', 'Interactive no-echo prompt (requires TTY)')
    .option('--from-stdin', 'Read value from piped stdin until EOF')
    .option('--from-file <path>', 'Read value from a file (trailing newline trimmed)')
    .option('--from-env <var>', 'Read value from a named environment variable')
    .option('--no-trim', 'When reading --from-file, keep the trailing newline (default: trim once)')
    .option('--locked', 'Mark the variable as locked (source overrides cannot replace it)')
    .option(
      '--confirm-fingerprint <sha256hex>',
      'Refuse the write unless SHA-256(value) matches this 64-hex string',
    )
    .option('--dry-run', 'Parse + validate the value, print fingerprint + length, do not write')
    .action(
      async (
        orgId: string,
        environment: string,
        key: string,
        opts: {
          value?: string;
          prompt?: boolean;
          fromStdin?: boolean;
          fromFile?: string;
          fromEnv?: string;
          trim?: boolean;
          locked?: boolean;
          confirmFingerprint?: string;
          dryRun?: boolean;
        },
      ) => {
        try {
          const { value, source } = await resolveSecretInput(opts);

          if (opts.dryRun) {
            console.log(
              `[dry-run] would set variable '${key}' in environment '${environment}' for org ${orgId} ` +
                `(${value.length} chars, source=${source}, locked=${Boolean(opts.locked)}, ` +
                `sha256=${fingerprintValue(value)})`,
            );
            return;
          }

          await getClient().setVariable(orgId, environment, key, value, opts.locked);
          const lockTag = opts.locked ? ' [locked]' : '';
          console.log(
            `Variable '${key}' set in environment '${environment}' for org ${orgId}${lockTag}.`,
          );
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  vr.command('delete <orgId> <environment> <key>')
    .description('Delete an environment variable')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (orgId: string, environment: string, key: string, opts: { yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const confirmed = await confirm(
            `Are you sure you want to delete variable '${key}' from environment '${environment}'?`,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }
        await getClient().deleteVariable(orgId, environment, key);
        console.log(
          `Variable '${key}' deleted from environment '${environment}' for org ${orgId}.`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

async function confirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
