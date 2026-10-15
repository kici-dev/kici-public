/**
 * `kici-admin agent install`: registers the agent as a native service.
 * Folder-anchored: it writes an instance manifest into `--instance-dir`
 * (default: CWD) and a host-wide index row, from which every lifecycle command
 * rebuilds the ServiceConfig. A same-named foreign instance is refused without `--force`.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  createServiceManager,
  detectPlatform,
  getConfigDir,
  getLogDir,
  kiciConfigRoot,
  listInstances,
  writeInstallManifest,
  appendIndexEntry,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
  SERVICE_TEXT,
  readKiciVersion,
  restrictEnvFileAccess,
} from '../../service/index.js';
import { AGENT_DEFAULT_PORT } from '@kici-dev/shared/env';
import {
  assertServerResolvable,
  resolveServerScript,
  resolveServiceExecutable,
  type ModuleResolver,
} from '../../service/entrypoint.js';
import { renderAgentEnvFile } from './agent-env.js';
import type { InstanceManifest, ServiceConfig, ServicePlatform } from '../../service/index.js';
import { getInstallBase } from '../shared/versioned-upgrade.js';
import { ENV_FILE_MODE } from '../shared/env-file-mode.js';
import { copyFileSecurelySync, writeFileSecurelySync } from '../../../helpers/secure-write.js';
import { cliAction } from '../shared/cli-action.js';

interface InstallOptions {
  platform?: ServicePlatform;
  envFile?: string;
  binary?: string;
  wizard?: boolean;
  name: string;
  orchestratorUrl?: string;
  token?: string;
  labels?: string;
  port?: string;
  system?: boolean;
  userLevel?: boolean;
  instanceDir?: string;
  force?: boolean;
}

/** `--port` as a TCP port number; exits with an error for anything else. */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    console.error(`Error: --port must be a TCP port between 1 and 65535 (got "${value}")`);
    process.exit(1);
  }
  return port;
}

export function registerAgentInstall(agent: Command): void {
  agent
    .command('install')
    .description('Install the agent as a system service')
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: detected from the host',
    )
    .option('--env-file <path>', 'Path to existing env/config file to use')
    .option('--binary <path>', 'Path to agent binary (default: current executable)')
    .option('--name <name>', 'Service name', 'kici-agent')
    .option('--orchestrator-url <url>', 'URL of the orchestrator to connect to')
    .option('--token <token>', 'Agent authentication token')
    .option('--labels <labels>', 'Comma-separated agent labels for routing')
    .option(
      '--port <port>',
      `HTTP port for the agent's health and metrics endpoints; each agent on one host needs its own (default: ${AGENT_DEFAULT_PORT})`,
    )
    .option('--wizard', 'Interactive wizard for guided setup')
    .option('--system', 'Install as system-level service (requires root)')
    .option('--user-level', 'Install as user-level service (no root required)')
    .option(
      '--instance-dir <path>',
      'Deploy folder; the instance manifest is written here (default: current working directory)',
    )
    .option('--force', 'Overwrite an existing same-named foreign instance')
    .action(
      cliAction(async (opts: InstallOptions) => {
        // A standalone kici-admin has no import.meta.resolve, so without --binary
        // it stops here, before the wizard or any file.
        const resolveModule: ModuleResolver | undefined =
          typeof import.meta.resolve === 'function'
            ? (specifier) => import.meta.resolve(specifier)
            : undefined;
        assertServerResolvable('agent', opts.binary, resolveModule);
        if (opts.wizard && opts.envFile) {
          console.error('Error: Cannot use --wizard with --env-file');
          process.exit(1);
        }
        const port = parsePort(opts.port);

        const platform = detectPlatform(opts.platform as ServicePlatform | undefined);
        const userLevel = resolveUserLevel(opts);
        const serviceName = opts.name;
        const instanceDir = path.resolve(opts.instanceDir ?? process.cwd());
        const kiciRoot = kiciConfigRoot(userLevel);

        console.log(`Platform: ${platform}`);
        console.log(`Privilege: ${userLevel ? 'user' : 'system'}`);
        console.log(`Service name: ${serviceName}`);
        console.log(`Instance dir: ${instanceDir}`);

        // Created before the create-path guard, which reconciles the index against the native scan.
        const manager = await createServiceManager(platform);

        // Refuse to clobber a same-named foreign instance (installed at another
        // path, or found in the init system with no manifest) unless --force.
        // The scan names no driver, so it also sees e.g. a compose agent of this
        // name on a systemd host.
        const existingInstances = await listInstances({
          component: 'agent',
          isUserLevel: userLevel,
          kiciRoot,
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

        const configDir = getConfigDir(serviceName, userLevel);
        const logDir = getLogDir(serviceName, userLevel);

        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(logDir, { recursive: true });

        const envFilePath = path.join(configDir, `${serviceName}.env`);

        // On Windows a file mode protects nothing: restrict the folder before
        // the first secret lands, so neither the env file nor the temporary file
        // its write stages through is readable by other accounts. A user-level
        // folder is already private in its user's profile.
        if (platform === 'windows' && !userLevel) restrictEnvFileAccess(envFilePath);

        if (opts.wizard) {
          const { runAgentWizard } = await import('../../wizard/agent-wizard.js');
          const wizardConfig = await runAgentWizard();
          const envContent = renderAgentEnvFile({
            header: '# KiCI agent configuration (generated by setup wizard)',
            orchestratorUrl: wizardConfig.orchestratorUrl,
            token: wizardConfig.agentToken,
            labels: wizardConfig.labels,
            port,
          });
          writeFileSecurelySync(envFilePath, envContent, ENV_FILE_MODE);
          console.log(`Wrote wizard configuration to ${envFilePath}`);
        } else if (opts.envFile) {
          const source = path.resolve(opts.envFile);
          if (!fs.existsSync(source)) {
            console.error(`Error: env file not found: ${source}`);
            process.exit(1);
          }
          copyFileSecurelySync(source, envFilePath, ENV_FILE_MODE);
          console.log(`Copied env file to ${envFilePath}`);
        } else if (!fs.existsSync(envFilePath)) {
          const envContent = renderAgentEnvFile({
            header: '# KiCI agent configuration',
            orchestratorUrl: opts.orchestratorUrl,
            token: opts.token,
            labels: opts.labels
              ?.split(',')
              .map((l) => l.trim())
              .filter(Boolean),
            port,
          });
          writeFileSecurelySync(envFilePath, envContent, ENV_FILE_MODE);
          console.log(`Created env file at ${envFilePath}`);
        }

        // The env file carries KICI_AGENT_TOKEN, so it is owner-readable only. The
        // writes above stage through a temp file at that mode; this chmod covers
        // a pre-existing file the install left untouched.
        if (fs.existsSync(envFilePath)) {
          fs.chmodSync(envFilePath, ENV_FILE_MODE);
        }

        // --binary runs directly (assumed self-launching). Otherwise Node runs the
        // agent server entry: `npm install -g kici-admin` exposes only the CLI
        // bin, and a bare Node with no script opens a REPL.
        const entryScript = opts.binary
          ? undefined
          : resolveServerScript('@kici-dev/agent/server', 'agent', resolveModule);
        const { executablePath, args } = resolveServiceExecutable({
          binary: opts.binary ? path.resolve(opts.binary) : undefined,
          nodePath: process.execPath,
          entryScript,
        });

        const config: ServiceConfig = {
          name: serviceName,
          ...SERVICE_TEXT.agent,
          executablePath,
          args,
          // On the service PATH, so steps find node even when --binary wraps it.
          nodeBinDir: path.dirname(process.execPath),
          envFilePath,
          workingDirectory: configDir,
          isUserLevel: userLevel,
          component: 'agent',
          instanceDir,
          restartPolicy: DEFAULT_RESTART_POLICY,
        };

        await manager.install(config);

        // The manifest is the source of truth for every lifecycle command. A
        // re-install updates it, keeping the creation time and recording the
        // version the launcher runs.
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
        const { file: manifestFile, warning: manifestWarning } = writeInstallManifest(
          instanceDir,
          manifest,
          { execPath: executablePath, args },
        );
        if (manifestWarning) console.warn(`Warning: ${manifestWarning}`);

        try {
          appendIndexEntry(kiciRoot, {
            component: 'agent',
            name: serviceName,
            platform,
            isUserLevel: userLevel,
            instanceDir,
          });
        } catch (err) {
          // Throws on a same-name, different-dir collision; the unit is already
          // installed, so warn rather than tear it down.
          console.warn(`Warning: instance index append failed: ${(err as Error).message}`);
        }

        console.log(`\nAgent service "${serviceName}" installed successfully.`);
        console.log(`  Config:   ${envFilePath}`);
        console.log(`  Logs:     ${logDir}`);
        console.log(`  Manifest: ${manifestFile}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Edit ${envFilePath} with your configuration`);
        console.log(`  2. Run \`kici-admin agent start\` to start the service`);
      }),
    );
}
