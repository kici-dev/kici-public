/** `kici workflows list`: permanently registered workflows, from the Platform API. */

import pc from 'picocolors';
import { formatRelativeTime } from '../format.js';
import {
  DashboardClient,
  DashboardClientError,
  type RegistrationsListResult,
} from '../remote/dashboard-client.js';
import { toErrorMessage } from '@kici-dev/core';
import { parseDuration } from '@kici-dev/engine';

export interface WorkflowsListOptions {
  json?: boolean;
  /** Stale-registration threshold, e.g. "30d", "24h". */
  stale?: string;
  triggerType?: string;
  repo?: string;
}

type RegistrationsResponse = RegistrationsListResult;

export async function workflowsListCommand(options: WorkflowsListOptions = {}): Promise<boolean> {
  try {
    const client = await DashboardClient.load();

    const filters: { triggerType?: string; repoIdentifier?: string } = {};
    if (options.triggerType) filters.triggerType = options.triggerType;
    if (options.repo) filters.repoIdentifier = options.repo;

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

    // A never-triggered registration counts as stale.
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

    if (options.json) {
      console.log(JSON.stringify(registrations, null, 2));
      return true;
    }

    if (registrations.length === 0) {
      console.log(pc.yellow('No registered workflows found.'));
      return true;
    }

    const termWidth = process.stdout.columns || 100;

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

    const totalGaps = (headers.length - 1) * 3; // 3 chars between columns
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + totalGaps;
    if (totalWidth > termWidth) {
      // Shrink the widest column first, never below its header.
      let excess = totalWidth - termWidth;
      while (excess > 0) {
        const maxIdx = colWidths.indexOf(Math.max(...colWidths));
        const reduction = Math.min(excess, Math.max(0, colWidths[maxIdx] - headers[maxIdx].length));
        if (reduction === 0) break;
        colWidths[maxIdx] -= reduction;
        excess -= reduction;
      }
    }

    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('   ');
    console.log(pc.bold(headerLine));

    for (const row of rows) {
      const cells = row.map((cell, i) => {
        const maxW = colWidths[i];
        const truncated = cell.length > maxW ? cell.slice(0, maxW - 1) + '\u2026' : cell;
        const padded = truncated.padEnd(maxW);

        if (cell === 'Never') return pc.dim(padded);
        return padded;
      });
      console.log(cells.join('   '));
    }

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
