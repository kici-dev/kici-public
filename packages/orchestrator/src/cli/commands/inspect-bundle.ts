/**
 * `kici-admin inspect-bundle <path>`: summarize a debug bundle ZIP. Fully
 * offline: needs no running orchestrator or network.
 */

import type { Command } from 'commander';
import { readDebugBundle, type BundleSummary } from '../../diagnostics/bundle-reader.js';
import { formatBytes } from '@kici-dev/shared';
import { cliAction } from './shared/cli-action.js';

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

function colorizeStatus(status: string): string {
  switch (status) {
    case 'pass':
      return `${COLORS.green}PASS${COLORS.reset}`;
    case 'warn':
      return `${COLORS.yellow}WARN${COLORS.reset}`;
    case 'fail':
      return `${COLORS.red}FAIL${COLORS.reset}`;
    default:
      return status;
  }
}

function printSummary(summary: BundleSummary): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${COLORS.bold}Debug bundle summary${COLORS.reset}`);
  lines.push('='.repeat(60));

  lines.push('');
  lines.push(`${COLORS.cyan}Bundle info${COLORS.reset}`);
  lines.push(`  Generated:      ${summary.manifest.generated_at}`);
  if (summary.manifest.orchestrator_id) {
    lines.push(`  Orchestrator:   ${summary.manifest.orchestrator_id}`);
  }
  if (summary.manifest.source) {
    lines.push(`  Source:          ${summary.manifest.source}`);
  }
  lines.push(`  Bundle version: ${summary.manifest.version}`);
  lines.push(`  Node:           ${summary.manifest.node_version}`);
  lines.push(`  Platform:       ${summary.manifest.platform}`);

  if (Object.keys(summary.systemInfo).length > 0) {
    lines.push('');
    lines.push(`${COLORS.cyan}System${COLORS.reset}`);
    const sys = summary.systemInfo;
    if (sys.platform) lines.push(`  OS:       ${sys.platform} ${sys.release ?? ''}`);
    if (sys.arch) lines.push(`  Arch:     ${sys.arch}`);
    if (sys.cpuCount) lines.push(`  CPUs:     ${sys.cpuCount}`);
    if (typeof sys.totalMemory === 'number')
      lines.push(`  Memory:   ${formatBytes(sys.totalMemory as number)}`);
    if (typeof sys.freeMemory === 'number')
      lines.push(`  Free:     ${formatBytes(sys.freeMemory as number)}`);
    if (typeof sys.uptime === 'number') {
      const hours = Math.floor((sys.uptime as number) / 3600);
      const mins = Math.floor(((sys.uptime as number) % 3600) / 60);
      lines.push(`  Uptime:   ${hours}h ${mins}m`);
    }
  }

  if (summary.checkResults.length > 0) {
    lines.push('');
    lines.push(`${COLORS.cyan}Health checks${COLORS.reset}`);

    const header =
      '  Status | Check                    | Message                          | Duration';
    lines.push(header);
    lines.push('  ' + '-'.repeat(header.length - 2));

    for (const check of summary.checkResults) {
      const status = colorizeStatus(check.status);
      const name = check.name.padEnd(24);
      const message = check.message.substring(0, 34).padEnd(34);
      const duration = `${check.durationMs}ms`;
      lines.push(`  ${status}  | ${name} | ${message} | ${duration}`);
    }

    const passCount = summary.checkResults.filter((c) => c.status === 'pass').length;
    lines.push('');
    lines.push(
      `  ${COLORS.green}${passCount} passed${COLORS.reset}, ` +
        `${COLORS.yellow}${summary.warningCount} warnings${COLORS.reset}, ` +
        `${COLORS.red}${summary.errorCount} failures${COLORS.reset}`,
    );
  }

  if (summary.logSummary) {
    lines.push('');
    lines.push(`${COLORS.cyan}Logs${COLORS.reset}`);
    lines.push(`  Total lines:  ${summary.logSummary.totalLines}`);
    lines.push(`  Errors:       ${summary.logSummary.errors}`);
    lines.push(`  Warnings:     ${summary.logSummary.warnings}`);
  }

  if (summary.configIssues.length > 0) {
    lines.push('');
    lines.push(`${COLORS.yellow}Config issues${COLORS.reset}`);
    for (const issue of summary.configIssues) {
      lines.push(`  - ${issue}`);
    }
  }

  lines.push('');
  console.log(lines.join('\n'));
}

/** Takes no getClient: the command works offline. */
export function registerInspectBundleCommand(program: Command): void {
  program
    .command('inspect-bundle <path>')
    .description('Parse and display a structured summary of a debug bundle')
    .action(
      cliAction(async (bundlePath: string) => {
        const summary = await readDebugBundle(bundlePath);
        printSummary(summary);
      }),
    );
}
