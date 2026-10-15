/** `kici-admin diagnose`. Exit codes: 0 all pass, 1 any warns, 2 any fails. */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage, diagnoseExitCode, type DiagnoseResponse } from '@kici-dev/shared';

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

function colorizeStatus(status: string): string {
  switch (status) {
    case 'pass':
    case 'healthy':
      return `${COLORS.green}${status}${COLORS.reset}`;
    case 'warn':
    case 'degraded':
      return `${COLORS.yellow}${status}${COLORS.reset}`;
    case 'fail':
    case 'unhealthy':
      return `${COLORS.red}${status}${COLORS.reset}`;
    default:
      return status;
  }
}

/**
 * Messages are cut at this many characters, so what a check wants an operator
 * to see in the default (non-`--json`) output must fit.
 */
export const DIAGNOSE_TABLE_MESSAGE_WIDTH = 42;

function formatDiagnoseTable(response: DiagnoseResponse): string {
  const lines: string[] = [];

  lines.push(
    `${COLORS.bold}Orchestrator diagnostics${COLORS.reset} ${COLORS.dim}(${response.timestamp})${COLORS.reset}`,
  );
  lines.push(`Overall: ${colorizeStatus(response.status)}`);
  lines.push('');

  const header =
    'Status  | Check                    | Message                                    | Duration';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const check of response.checks) {
    const status = colorizeStatus(check.status.padEnd(5));
    const name = check.name.padEnd(24);
    const message = check.message
      .substring(0, DIAGNOSE_TABLE_MESSAGE_WIDTH)
      .padEnd(DIAGNOSE_TABLE_MESSAGE_WIDTH);
    const duration = `${check.durationMs}ms`;
    lines.push(`${status}  | ${name} | ${message} | ${duration}`);
  }

  return lines.join('\n');
}

export function registerDiagnoseCommand(program: Command, getClient: () => AdminApiClient): void {
  program
    .command('diagnose')
    .description('Run diagnostic health checks on the orchestrator')
    .option('--json', 'Output raw JSON instead of formatted table')
    .action(async (opts: { json?: boolean }) => {
      try {
        const response = (await getClient().diagnose()) as DiagnoseResponse;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
        } else {
          console.log(formatDiagnoseTable(response));
        }

        const exitCode = diagnoseExitCode(response.checks);
        if (exitCode > 0) {
          process.exit(exitCode);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(2);
      }
    });
}
