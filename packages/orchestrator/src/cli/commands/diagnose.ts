/**
 * Diagnostic health check command for kici-admin.
 *
 * Calls the orchestrator's /admin/diagnose endpoint and displays
 * results as a formatted table or raw JSON.
 *
 * Exit codes:
 *   0 - all checks pass
 *   1 - any check warns
 *   2 - any check fails
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/** ANSI color codes for terminal output. */
const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

interface DiagnoseResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

interface DiagnoseResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: DiagnoseResult[];
  timestamp: string;
}

/**
 * Colorize a status string for terminal output.
 */
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
 * Format diagnostic results as a table.
 */
function formatDiagnoseTable(response: DiagnoseResponse): string {
  const lines: string[] = [];

  lines.push(
    `${COLORS.bold}Orchestrator diagnostics${COLORS.reset} ${COLORS.dim}(${response.timestamp})${COLORS.reset}`,
  );
  lines.push(`Overall: ${colorizeStatus(response.status)}`);
  lines.push('');

  // Table header
  const header =
    'Status  | Check                    | Message                                    | Duration';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const check of response.checks) {
    const status = colorizeStatus(check.status.padEnd(5));
    const name = check.name.padEnd(24);
    const message = check.message.substring(0, 42).padEnd(42);
    const duration = `${check.durationMs}ms`;
    lines.push(`${status}  | ${name} | ${message} | ${duration}`);
  }

  return lines.join('\n');
}

/**
 * Determine exit code from diagnostic results.
 */
function getExitCode(checks: DiagnoseResult[]): number {
  if (checks.some((c) => c.status === 'fail')) return 2;
  if (checks.some((c) => c.status === 'warn')) return 1;
  return 0;
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

        const exitCode = getExitCode(response.checks);
        if (exitCode > 0) {
          process.exit(exitCode);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(2);
      }
    });
}
