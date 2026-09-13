/**
 * Context variable management commands for kici-admin.
 *
 *   kici-admin variable list   <orgId> <context>
 *   kici-admin variable get    <orgId> <context> <key>
 *   kici-admin variable set    <orgId> <context> <key> [--value | --from-stdin | --from-file | --from-env | --prompt]
 *   kici-admin variable delete <orgId> <context> <key>
 *
 * Org-level context variables are plaintext-at-rest in the
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
  const vr = program.command('variable').description('Manage context variables');

  vr.command('list <orgId> <context>')
    .description('List org-level variables in a context')
    .option('--values', 'Print variable values inline (default: keys + locked flag only)')
    .action(async (orgId: string, context: string, opts: { values?: boolean }) => {
      try {
        const { variables } = await getClient().listVariables(orgId, context);
        if (variables.length === 0) {
          console.log('No variables in this context.');
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

  vr.command('get <orgId> <context> <key>')
    .description('Print the value of a single variable')
    .action(async (orgId: string, context: string, key: string) => {
      try {
        const { variables } = await getClient().listVariables(orgId, context);
        const match = variables.find((v) => v.key === key);
        if (!match) {
          console.error(`Variable '${key}' not found in context '${context}'.`);
          process.exit(1);
        }
        console.log(match.value);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  vr.command('set <orgId> <context> <key>')
    .description(
      'Set a context variable. Value comes from one of: --prompt (default on TTY), ' +
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
        context: string,
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
              `[dry-run] would set variable '${key}' in context '${context}' for org ${orgId} ` +
                `(${value.length} chars, source=${source}, locked=${Boolean(opts.locked)}, ` +
                `sha256=${fingerprintValue(value)})`,
            );
            return;
          }

          await getClient().setVariable(orgId, context, key, value, opts.locked);
          const lockTag = opts.locked ? ' [locked]' : '';
          console.log(`Variable '${key}' set in context '${context}' for org ${orgId}${lockTag}.`);
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  vr.command('delete <orgId> <context> <key>')
    .description('Delete a context variable')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (orgId: string, context: string, key: string, opts: { yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const confirmed = await confirm(
            `Are you sure you want to delete variable '${key}' from context '${context}'?`,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }
        await getClient().deleteVariable(orgId, context, key);
        console.log(`Variable '${key}' deleted from context '${context}' for org ${orgId}.`);
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
