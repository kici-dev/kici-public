/** kici diagnostics — mirrors the dashboard Diagnostics page (infra tree). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import type { DiagnosticsOrchestrator, DiagnosticsSummaryResponse } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../remote/dashboard-client.js';
import { relativeTime } from '../remote/render.js';

export interface DiagnosticsOptions {
  json?: boolean;
  verbose?: boolean;
  orchestrator?: string;
}

export async function diagnosticsCommand(options: DiagnosticsOptions = {}): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const [summary, infra] = await Promise.all([
      client.getDiagnosticsSummary(),
      client.getInfrastructure(),
    ]);

    let orchestrators = infra.orchestrators;
    if (options.orchestrator) {
      orchestrators = orchestrators.filter((o) => o.connectionId === options.orchestrator);
    }

    if (options.json) {
      console.log(JSON.stringify({ summary, orchestrators, alerts: infra.alerts }, null, 2));
      return true;
    }

    printSummary(summary);
    printAlerts(infra.alerts);
    if (orchestrators.length === 0) {
      console.log(pc.gray('\nNo orchestrators connected.'));
      return true;
    }
    for (const o of orchestrators) printOrchestrator(o, options.verbose ?? false);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

function printSummary(s: DiagnosticsSummaryResponse): void {
  const m = s.executionMetrics;
  console.log(
    pc.bold('\nDiagnostics') +
      pc.gray(
        `  runs(24h)=${m.totalRuns} success=${m.successRate}% ` +
          `avg=${m.avgDurationSeconds}s queued=${m.queuedJobs} running=${m.runningJobs}` +
          (s.orphanedConnections > 0 ? ` orphaned=${s.orphanedConnections}` : ''),
      ),
  );
}

function printAlerts(alerts: { type: string; message: string; severity: string }[]): void {
  for (const a of alerts) {
    const color = a.severity === 'critical' ? pc.red : pc.yellow;
    console.log(color(`  ! [${a.type}] ${a.message}`));
  }
}

function printOrchestrator(o: DiagnosticsOrchestrator, verbose: boolean): void {
  const hb = o.lastHeartbeat ? relativeTime(new Date(o.lastHeartbeat).toISOString()) : '—';
  const head =
    pc.bold(o.clusterName ?? o.connectionId) +
    pc.gray(
      ` [${o.connectionId}] keys=${o.routingKeys.join(',') || '—'} ` +
        `${o.connected ? pc.green('connected') : pc.red('disconnected')} ` +
        `raft=${o.raftRole ?? '—'} hb=${hb}`,
    );
  console.log(`\n${head}`);
  for (const sc of o.scalers) {
    console.log(
      pc.gray('  └─ ') +
        `${sc.name} (${sc.type}) ${sc.activeAgents}/${sc.maxAgents} ` +
        pc.gray(`labels=${sc.labelSets.map((set) => set.join('+')).join(' | ') || '—'}`),
    );
  }
  for (const ag of o.agents) {
    const extra = verbose
      ? ` host=${ag.hostname ?? '—'} node=${ag.nodeVersion ?? '—'} mem=${ag.memoryUsedMb ?? '—'}MB`
      : '';
    console.log(
      pc.gray('     • ') +
        `${ag.agentId} ` +
        pc.cyan(`[${ag.labels.join(',')}]`) +
        pc.gray(
          ` ${ag.platform}/${ag.arch} jobs=${ag.activeJobs}/${ag.maxConcurrency} ` +
            `hb=${relativeTime(new Date(ag.lastHeartbeatAt).toISOString())}${extra}`,
        ),
    );
  }
}
