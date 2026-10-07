/**
 * The service lifecycle verbs shared by `kici-admin agent` and `kici-admin orchestrator`:
 * `uninstall`, `start`, `stop`, `restart` and `logs`.
 *
 * Target resolution goes through resolveInstanceTarget — the priority chain every
 * lifecycle command uses (--instance-dir > --name > CWD manifest > refusal with
 * candidate list). `--name` has no default.
 */

import type { Command } from 'commander';
import {
  DEFAULT_RESTART_POLICY,
  InstanceNotFoundError,
  kiciConfigRoot,
  removeIndexEntry,
  resolveInstanceTarget,
  resolveUserLevel,
} from '../../service/index.js';
import type { LogOptions, ServiceConfig, ServicePlatform } from '../../service/index.js';
import { cliAction } from './cli-action.js';

export type ServiceComponent = 'agent' | 'orchestrator';

const SERVICE_IDENTITY: Record<
  ServiceComponent,
  { noun: string; displayName: string; description: string }
> = {
  agent: {
    noun: 'Agent',
    displayName: 'KiCI Agent',
    description: 'KiCI CI/CD workflow execution agent service',
  },
  orchestrator: {
    noun: 'Orchestrator',
    displayName: 'KiCI Orchestrator',
    description: 'KiCI CI/CD workflow orchestrator service',
  },
};

interface TargetOptions {
  platform?: ServicePlatform;
  name?: string;
  instanceDir?: string;
  system?: boolean;
  userLevel?: boolean;
}

interface LogsOptions extends TargetOptions {
  since?: string;
  level?: string;
  json?: boolean;
  follow: boolean;
}

function addVerb(parent: Command, verb: string, description: string, instanceDirHelp: string) {
  return parent
    .command(verb)
    .description(description)
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', instanceDirHelp)
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service');
}

async function resolveTarget(component: ServiceComponent, opts: TargetOptions) {
  const userLevel = resolveUserLevel(opts);
  const kiciRoot = kiciConfigRoot(userLevel);
  const { resolved, manager } = await resolveInstanceTarget({
    component,
    opts: { instanceDir: opts.instanceDir, name: opts.name },
    cwd: process.cwd(),
    kiciRoot,
    platformOverride: opts.platform,
    isUserLevel: userLevel,
  });
  const { displayName, description } = SERVICE_IDENTITY[component];
  const config: ServiceConfig = {
    name: resolved.manifest.name,
    displayName,
    description,
    executablePath: '',
    envFilePath: resolved.manifest.envFilePath,
    workingDirectory: resolved.manifest.configDir,
    isUserLevel: resolved.manifest.isUserLevel,
    restartPolicy: DEFAULT_RESTART_POLICY,
    component,
  };
  return { resolved, manager, config, kiciRoot };
}

/** `start` / `restart`: refuse an instance whose service is not installed. */
function requireInstalledThen(component: ServiceComponent, verb: 'start' | 'restart') {
  return cliAction(async (opts: TargetOptions) => {
    const { manager, config } = await resolveTarget(component, opts);
    if (!(await manager.isInstalled(config))) {
      console.error(`Error: service "${config.name}" is not installed.`);
      console.error(`Run \`kici-admin ${component} install\` first.`);
      process.exit(1);
    }
    await manager[verb](config);
    console.log(`${SERVICE_IDENTITY[component].noun} service "${config.name}" ${verb}ed.`);
  });
}

function registerUninstall(parent: Command, component: ServiceComponent): void {
  const { noun } = SERVICE_IDENTITY[component];
  addVerb(
    parent,
    'uninstall',
    `Remove the ${component} service registration`,
    'Deploy folder of the instance to uninstall',
  ).action(
    cliAction(async (opts: TargetOptions) => {
      try {
        const { resolved, manager, config, kiciRoot } = await resolveTarget(component, opts);
        if (!(await manager.isInstalled(config))) {
          console.log(`Service "${config.name}" is not installed.`);
        } else {
          try {
            const status = await manager.status(config);
            if (status.state === 'running') {
              console.log(`Stopping service "${config.name}"...`);
              await manager.stop(config);
            }
          } catch {
            // proceed with uninstall even if status/stop failed
          }
          await manager.uninstall(config);
        }
        // Always drop the index entry, even for an already-uninstalled service.
        removeIndexEntry(kiciRoot, { component, name: config.name });
        console.log(`\n${noun} service "${config.name}" uninstalled.`);
        console.log(
          `Manifest preserved at ${resolved.manifestPath} — delete manually if no longer needed.`,
        );
      } catch (err) {
        if (!(err instanceof InstanceNotFoundError)) throw err;
        console.log(
          `${noun} service "${err.instanceName}" is not installed — nothing to uninstall.`,
        );
      }
    }),
  );
}

function registerStop(parent: Command, component: ServiceComponent): void {
  const { noun } = SERVICE_IDENTITY[component];
  addVerb(
    parent,
    'stop',
    `Stop the ${component} service`,
    'Deploy folder of the instance to stop',
  ).action(
    cliAction(async (opts: TargetOptions) => {
      try {
        const { manager, config } = await resolveTarget(component, opts);
        await manager.stop(config);
        console.log(`${noun} service "${config.name}" stopped.`);
      } catch (err) {
        if (!(err instanceof InstanceNotFoundError)) throw err;
        console.log(`${noun} service "${err.instanceName}" is not installed — nothing to stop.`);
      }
    }),
  );
}

/**
 * Register `uninstall`, `start`, `stop` and `restart` on a component's command group.
 * Commander lists subcommands in registration order, so the caller places this
 * between `install` and `status`.
 */
export function registerServiceLifecycleVerbs(parent: Command, component: ServiceComponent): void {
  registerUninstall(parent, component);
  addVerb(
    parent,
    'start',
    `Start the ${component} service`,
    'Deploy folder of the instance to start',
  ).action(requireInstalledThen(component, 'start'));
  registerStop(parent, component);
  addVerb(
    parent,
    'restart',
    `Restart the ${component} service`,
    'Deploy folder of the instance to restart',
  ).action(requireInstalledThen(component, 'restart'));
}

/** Register `logs` on a component's command group (listed after `status`). */
export function registerServiceLogsVerb(parent: Command, component: ServiceComponent): void {
  addVerb(
    parent,
    'logs',
    `Tail and follow ${component} service logs`,
    'Deploy folder of the instance whose logs to read',
  )
    .option('--since <duration>', 'Show logs since duration (e.g. 1h, 30m)')
    .option('--level <level>', 'Filter by log level (error|warn|info)')
    .option('--json', 'Output as structured JSON')
    .option('--no-follow', 'Snapshot mode (do not tail)')
    .action(
      cliAction(async (opts: LogsOptions) => {
        const { manager, config } = await resolveTarget(component, opts);
        const logOptions: LogOptions = {
          since: opts.since,
          level: opts.level as LogOptions['level'],
          json: opts.json,
          follow: opts.follow,
        };
        await manager.logs(config, logOptions);
      }),
    );
}
