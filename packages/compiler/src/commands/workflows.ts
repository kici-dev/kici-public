/**
 * kici workflows list command
 *
 * Lists permanently registered workflows by querying the Platform API.
 * Supports table output (default), JSON output, and stale filtering.
 */

import pc from 'picocolors';
import { formatRelativeTime } from '../format.js';
import {
  DashboardClient,
  DashboardClientError,
  type RegistrationsListResult,
} from '../remote/dashboard-client.js';
import { toErrorMessage } from '@kici-dev/core';

/** Options for the workflows list command. */
export interface WorkflowsListOptions {
  /** Output as JSON */
  json?: boolean;
  /** Filter stale registrations (e.g., "30d", "7d", "24h") */
  stale?: string;
  /** Filter by trigger type */
  triggerType?: string;
  /** Filter by repository */
  repo?: string;
}

/** API response shape (the Platform registrations-list payload). */
type RegistrationsResponse = RegistrationsListResult;

/**
 * Parse a duration string like "30d", "7d", "24h", "2h" into milliseconds.
 * Returns null if the string is not a valid duration.
 */
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)(d|h|m)$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    default:
      return null;
  }
}

/**
 * List permanently registered workflows.
 *
 * Queries the Platform API for registrations, optionally filtering by trigger type,
 * repository, or staleness. Displays results as a table or JSON.
 *
 * @param options - Command options
 * @returns true on success, false on error
 */
export async function workflowsListCommand(options: WorkflowsListOptions = {}): Promise<boolean> {
  try {
    const client = await DashboardClient.load();

    // Build query params
    const filters: { triggerType?: string; repoIdentifier?: string } = {};
    if (options.triggerType) filters.triggerType = options.triggerType;
    if (options.repo) filters.repoIdentifier = options.repo;

    // Fetch registrations through the Platform
    let data: RegistrationsResponse;
    try {
      data = await client.listRegistrations(filters);
    } catch (error) {
      if (error instanceof DashboardClientError) {
        if (error.kind === 'orchestrator_offline') {
          console.error(
            pc.red('No orchestrator connected. Ensure your orchestrator is running and connected.'),
          );
          return false;
        }
        console.error(pc.red(error.message));
        return false;
      }
      throw error;
    }

    let registrations = data.registrations;

    // Apply stale filtering
    if (options.stale) {
      const staleMs = parseDuration(options.stale);
      if (staleMs === null) {
        console.error(
          pc.red(`Invalid duration format: "${options.stale}". Use e.g., 30d, 7d, 24h`),
        );
        return false;
      }

      const now = Date.now();
      registrations = registrations.filter((r) => {
        if (r.lastTriggeredAt === null) return true;
        return now - new Date(r.lastTriggeredAt).getTime() > staleMs;
      });
    }

    // JSON output mode
    if (options.json) {
      console.log(JSON.stringify(registrations, null, 2));
      return true;
    }

    // Empty result
    if (registrations.length === 0) {
      console.log(pc.yellow('No registered workflows found.'));
      return true;
    }

    // Table output
    const termWidth = process.stdout.columns || 100;

    // Calculate column widths
    const headers = ['WORKFLOW', 'REPO', 'TRIGGERS', 'LAST TRIGGERED'];
    const rows = registrations.map((r) => [
      r.workflowName,
      r.repoIdentifier,
      r.triggerTypes.join(', '),
      r.lastTriggeredAt ? formatRelativeTime(r.lastTriggeredAt) : 'Never',
    ]);

    const colWidths = headers.map((h, i) => {
      const maxData = Math.max(...rows.map((r) => r[i].length));
      return Math.max(h.length, maxData);
    });

    // Truncate columns to fit terminal width
    const totalGaps = (headers.length - 1) * 3; // 3 chars between columns
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + totalGaps;
    if (totalWidth > termWidth) {
      // Shrink the widest columns first
      let excess = totalWidth - termWidth;
      while (excess > 0) {
        const maxIdx = colWidths.indexOf(Math.max(...colWidths));
        const reduction = Math.min(excess, Math.max(0, colWidths[maxIdx] - headers[maxIdx].length));
        if (reduction === 0) break;
        colWidths[maxIdx] -= reduction;
        excess -= reduction;
      }
    }

    // Print header
    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('   ');
    console.log(pc.bold(headerLine));

    // Print rows
    for (const row of rows) {
      const cells = row.map((cell, i) => {
        const maxW = colWidths[i];
        const truncated = cell.length > maxW ? cell.slice(0, maxW - 1) + '\u2026' : cell;
        const padded = truncated.padEnd(maxW);

        // Color "Never" values dim
        if (cell === 'Never') return pc.dim(padded);
        return padded;
      });
      console.log(cells.join('   '));
    }

    // Registry info
    console.log('');
    console.log(
      pc.gray(
        `Registry v${data.registryVersion}, last updated ${formatRelativeTime(data.registryUpdatedAt)}`,
      ),
    );

    return true;
  } catch (err: unknown) {
    if (err instanceof DashboardClientError) {
      console.error(pc.red(err.message));
      return false;
    }
    const message = toErrorMessage(err);
    console.error(pc.red(`Failed to list workflows: ${message}`));
    return false;
  }
}
