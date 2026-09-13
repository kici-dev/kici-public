/**
 * Standalone scaler maintenance commands for kici-admin.
 *
 *   scaler reap-orphans   Free leaked Firecracker/container resources WITHOUT a
 *                         running orchestrator (recovery for a wedged node whose
 *                         data disk is full).
 *
 * This command loads the orchestrator's LOCAL config (no HTTP admin API, no DB)
 * and runs the liveness-driven reaper. It is the sanctioned operator path for
 * the ENOSPC bootstrap deadlock: when the data disk is 100% full the
 * orchestrator crash-loops before its in-process orphan sweep can run, so a
 * tool that frees disk WITHOUT the orchestrator is required.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { loadLocalConfig } from '../../config/loader.js';
import { loadScalerConfig } from '../../scaler/config.js';
import { reapAllOrphans } from '../../scaler/reap-orphans.js';

/** Probe the local orchestrator /health endpoint. Healthy => it reaps itself. */
export async function isOrchestratorHealthy(port: number, basePath: string): Promise<boolean> {
  const prefix = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const url = `http://127.0.0.1:${port}${prefix}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function registerScalerCommands(program: Command): void {
  const scaler = program
    .command('scaler')
    .description('Scaler maintenance (local, no orchestrator)');

  scaler
    .command('reap-orphans')
    .description('Free leaked Firecracker/container resources without a running orchestrator')
    .option(
      '--config <path>',
      'Path to the orchestrator config (default: KICI_CONFIG or /etc/kici/orchestrator.yaml)',
    )
    .option('--force', 'Reap even if the local orchestrator reports healthy', false)
    .option('--json', 'Emit machine-readable JSON counts', false)
    .action(async (opts: { config?: string; force: boolean; json: boolean }) => {
      try {
        const local = await loadLocalConfig(opts.config);
        // Resolve the scaler config path from the same sources the orchestrator
        // itself uses: the local YAML's scaler.configPath, or the env var that
        // env-only workers (the rootless edge peers this command recovers) set.
        const scalerConfigPath = local.scaler?.configPath ?? process.env.KICI_SCALER_CONFIG_PATH;
        const scalerConfigDir = local.scaler?.configDir ?? process.env.KICI_SCALER_CONFIG_DIR;
        if (!scalerConfigPath) {
          console.error(
            'Error: no scaler config path found (set scaler.configPath in the orchestrator ' +
              'config, KICI_SCALER_CONFIG_PATH in the environment, or pass --config)',
          );
          process.exit(1);
        }
        const scalerConfig = await loadScalerConfig(scalerConfigPath, scalerConfigDir);

        const port = local.server?.port ?? Number(process.env.KICI_PORT ?? '4000');
        const basePath = local.server?.basePath ?? process.env.KICI_BASE_PATH ?? '/';
        const healthy = opts.force ? false : await isOrchestratorHealthy(port, basePath);

        if (healthy && !opts.force) {
          const msg = 'orchestrator is up and reaps orphans itself; pass --force to reap anyway';
          if (opts.json) {
            console.log(
              JSON.stringify({ skipped: true, reason: 'orchestrator-healthy', counts: {} }),
            );
          } else {
            console.log(msg);
          }
          process.exit(0);
        }

        // Orchestrator is down/wedged (or --force): FC reap is liveness-driven
        // (safe); container reap is unconditional but safe because the
        // orchestrator is not running.
        const counts = await reapAllOrphans({ scalerConfig, includeContainers: true });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        if (opts.json) {
          console.log(JSON.stringify({ skipped: false, counts, total }));
        } else if (total === 0) {
          console.log('No orphan resources found.');
        } else {
          console.log(`Reaped ${total} orphan resource(s):`);
          for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
