/**
 * `kici-admin agent install` command.
 *
 * Registers the agent as a native system service on the current platform.
 * Accepts orchestrator URL and token for connecting to the orchestrator.
 *
 * Targeting is folder-anchored: the install writes an instance manifest
 * into the deploy folder (`--instance-dir`, default: CWD) and appends a
 * row to the host-wide instance index so every lifecycle command can
 * reconstruct the ServiceConfig without re-deriving paths. A create-path
 * guard refuses to clobber a same-named foreign instance unless `--force`
 * is passed.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServiceManager,
  detectPlatform,
  getConfigDir,
  getLogDir,
  kiciConfigRoot,
  listInstances,
  writeManifest,
  appendIndexEntry,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
  readKiciVersion,
} from '../../service/index.js';
import { resolveServiceExecutable } from '../../service/entrypoint.js';
import type { InstanceManifest, ServiceConfig, ServicePlatform } from '../../service/index.js';
import { getInstallBase } from '../shared/versioned-upgrade.js';
import { toErrorMessage } from '@kici-dev/shared';

interface InstallOptions {
  platform?: ServicePlatform;
  envFile?: string;
  binary?: string;
  wizard?: boolean;
  name: string;
  orchestratorUrl?: string;
  token?: string;
  labels?: string;
  system?: boolean;
  userLevel?: boolean;
  instanceDir?: string;
  force?: boolean;
}

export function registerAgentInstall(agent: Command): void {
  agent
    .command('install')
    .description('Install the agent as a system service')
    .option('--platform <type>', 'Service platform (systemd, launchd, windows, compose)')
    .option('--env-file <path>', 'Path to existing env/config file to use')
    .option('--binary <path>', 'Path to agent binary (default: current executable)')
    .option('--name <name>', 'Service name', 'kici-agent')
    .option('--orchestrator-url <url>', 'URL of the orchestrator to connect to')
    .option('--token <token>', 'Agent authentication token')
    .option('--labels <labels>', 'Comma-separated agent labels for routing')
    .option('--wizard', 'Interactive wizard for guided setup')
    .option('--system', 'Install as system-level service (requires root)')
    .option('--user-level', 'Install as user-level service (no root required)')
    .option(
      '--instance-dir <path>',
      'Deploy folder; the instance manifest is written here (default: current working directory)',
    )
    .option('--force', 'Overwrite an existing same-named foreign instance')
    .action(async (opts: InstallOptions) => {
      try {
        if (opts.wizard && opts.envFile) {
          console.error('Error: Cannot use --wizard with --env-file');
          process.exit(1);
        }

        const platform = detectPlatform(opts.platform as ServicePlatform | undefined);
        const userLevel = resolveUserLevel(opts);
        const serviceName = opts.name;
        const instanceDir = path.resolve(opts.instanceDir ?? process.cwd());
        const kiciRoot = kiciConfigRoot(userLevel);

        console.log(`Platform: ${platform}`);
        console.log(`Privilege: ${userLevel ? 'user' : 'system'}`);
        console.log(`Service name: ${serviceName}`);
        console.log(`Instance dir: ${instanceDir}`);

        // Create service manager early so the create-path guard can reconcile
        // the index against the driver's native scan.
        const manager = await createServiceManager(platform);

        // Create-path guard: refuse to clobber a same-named foreign instance
        // (one already installed at a different path, or one discovered in the
        // init system with no manifest yet). --force overrides.
        const existingInstances = await listInstances({
          component: 'agent',
          isUserLevel: userLevel,
          kiciRoot,
          manager,
        });
        const existing = existingInstances.find((c) => c.name === serviceName);
        if (existing && existing.instanceDir !== instanceDir && !opts.force) {
          const at = existing.instanceDir ?? '(no manifest)';
          console.error(
            `Error: an agent instance "${serviceName}" is already installed at ${at}. ` +
              `Pass a different --name, a different --instance-dir, or --force to overwrite.`,
          );
          process.exit(1);
        }

        // Resolve directories
        const configDir = getConfigDir(serviceName, userLevel);
        const logDir = getLogDir(serviceName, userLevel);

        // Ensure directories exist
        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(logDir, { recursive: true });

        const envFilePath = path.join(configDir, `${serviceName}.env`);

        // Handle wizard mode
        if (opts.wizard) {
          const { runAgentWizard } = await import('../../wizard/agent-wizard.js');
          const wizardConfig = await runAgentWizard();
          let envContent = '# KiCI agent configuration (generated by setup wizard)\n';
          envContent += `KICI_ORCHESTRATOR_URL=${wizardConfig.orchestratorUrl}\n`;
          envContent += `KICI_AGENT_TOKEN=${wizardConfig.agentToken}\n`;
          if (wizardConfig.labels.length > 0) {
            envContent += `KICI_AGENT_LABELS=${wizardConfig.labels.join(',')}\n`;
          }
          fs.writeFileSync(envFilePath, envContent, 'utf-8');
          console.log(`Wrote wizard configuration to ${envFilePath}`);
        } else if (opts.envFile) {
          const source = path.resolve(opts.envFile);
          if (!fs.existsSync(source)) {
            console.error(`Error: env file not found: ${source}`);
            process.exit(1);
          }
          fs.copyFileSync(source, envFilePath);
          console.log(`Copied env file to ${envFilePath}`);
        } else if (!fs.existsSync(envFilePath)) {
          // Create env file with agent-specific config
          let envContent = `# KiCI agent configuration\n`;
          if (opts.orchestratorUrl) {
            envContent += `KICI_ORCHESTRATOR_URL=${opts.orchestratorUrl}\n`;
          }
          if (opts.token) {
            envContent += `KICI_AGENT_TOKEN=${opts.token}\n`;
          }
          if (opts.labels) {
            envContent += `KICI_AGENT_LABELS=${opts.labels}\n`;
          }
          fs.writeFileSync(envFilePath, envContent, 'utf-8');
          console.log(`Created env file at ${envFilePath}`);
        }

        // Resolve the run command. With an explicit --binary we run it directly
        // (assumed self-launching). Otherwise we run Node against the installed
        // agent server entry (dist/server.js) — `npm install -g kici-admin`
        // exposes only the CLI bin, not a self-launching agent server binary, so
        // a bare Node with no script argument would just open a REPL.
        const entryScript = opts.binary
          ? undefined
          : fileURLToPath(import.meta.resolve('@kici-dev/agent/server'));
        const { executablePath, args } = resolveServiceExecutable({
          binary: opts.binary ? path.resolve(opts.binary) : undefined,
          nodePath: process.execPath,
          entryScript,
        });

        // Build ServiceConfig
        const config: ServiceConfig = {
          name: serviceName,
          displayName: 'KiCI Agent',
          description: 'KiCI CI/CD workflow execution agent service',
          executablePath,
          args,
          // Bake the install-time node bin dir onto the service PATH so
          // workflow steps can find node even when --binary wraps it.
          nodeBinDir: path.dirname(process.execPath),
          envFilePath,
          workingDirectory: configDir,
          isUserLevel: userLevel,
          component: 'agent',
          instanceDir,
          restartPolicy: DEFAULT_RESTART_POLICY,
        };

        await manager.install(config);

        // Write the instance manifest into the deploy folder. This is the
        // single source of truth every lifecycle command reads to reconstruct
        // the ServiceConfig without re-deriving paths.
        const manifest: InstanceManifest = {
          component: 'agent',
          name: serviceName,
          platform,
          isUserLevel: userLevel,
          envFilePath,
          configDir,
          logDir,
          installBase: getInstallBase(platform, serviceName),
          createdAt: new Date().toISOString(),
          kiciVersion: readKiciVersion(),
        };
        const manifestFile = writeManifest(instanceDir, manifest);

        // Register the instance in the host-wide index cache.
        try {
          appendIndexEntry(kiciRoot, {
            component: 'agent',
            name: serviceName,
            platform,
            isUserLevel: userLevel,
            instanceDir,
          });
        } catch (err) {
          // appendIndexEntry throws on a same-name-different-dir collision; at
          // this point the unit is already installed, so warn loudly rather
          // than tear down the install.
          console.warn(`Warning: instance index append failed: ${(err as Error).message}`);
        }

        console.log(`\nAgent service "${serviceName}" installed successfully.`);
        console.log(`  Config:   ${envFilePath}`);
        console.log(`  Logs:     ${logDir}`);
        console.log(`  Manifest: ${manifestFile}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Edit ${envFilePath} with your configuration`);
        console.log(`  2. Run \`kici-admin agent start\` to start the service`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
