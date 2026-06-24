/**
 * `kici-admin orchestrator install` command.
 *
 * Registers the orchestrator as a native system service on the current platform.
 * Auto-detects platform and privilege level, creates config directories,
 * writes env file, and registers the service with the init system.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import { selectServerEntry, resolveServiceExecutable } from '../../service/entrypoint.js';
import { buildDeployEnvLines, upsertDeployEnvLines } from '../../service/deploy-env.js';
import { detectRuntime } from '../../service/compose.js';
import type { InstanceManifest, ServiceConfig, ServicePlatform } from '../../service/index.js';
import { getInstallBase } from '../shared/versioned-upgrade.js';
import { toErrorMessage } from '@kici-dev/shared';

interface InstallOptions {
  platform?: ServicePlatform;
  envFile?: string;
  binary?: string;
  dev?: boolean;
  wizard?: boolean;
  name: string;
  system?: boolean;
  userLevel?: boolean;
  user?: string;
  instanceDir?: string;
  force?: boolean;
}

/**
 * Spin up a dev PostgreSQL container using Docker or Podman.
 * Returns the DATABASE_URL for the container.
 */
function startDevPostgres(containerName: string): string {
  const password = crypto.randomBytes(16).toString('hex');
  const port = 15432;

  // Detect container runtime
  let runtime = 'podman';
  try {
    execSync('podman --version', { stdio: 'ignore' });
  } catch {
    runtime = 'docker';
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch {
      throw new Error('Neither podman nor docker found. Install one to use --dev mode.');
    }
  }

  // Check if container already exists
  try {
    const existing = execSync(
      `${runtime} ps -a --filter name=${containerName} --format "{{.Names}}"`,
      {
        encoding: 'utf-8',
      },
    ).trim();
    if (existing) {
      console.log(`Dev PostgreSQL container "${containerName}" already exists.`);
      console.log(`Remove it with: ${runtime} rm -f ${containerName}`);
      throw new Error(`Container "${containerName}" already exists`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // Container doesn't exist, continue
  }

  console.log(`Starting dev PostgreSQL container "${containerName}" on port ${port}...`);
  // Pass POSTGRES_PASSWORD via --env-file rather than -e KEY=value argv so
  // the password never lands in the operator's `ps aux` output or shell
  // history. Tempfile is created with 0600 and removed in a finally — the
  // plaintext window is the few microseconds podman takes to read the
  // file before forking the container. POSTGRES_DB stays on the argv since
  // it isn't sensitive.
  const tmpEnvFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kici-dev-pg-')),
    'postgres.env',
  );
  try {
    fs.writeFileSync(tmpEnvFile, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
    execSync(
      `${runtime} run -d --name ${containerName} -p ${port}:5432 --env-file ${tmpEnvFile} -e POSTGRES_DB=kici postgres:18-trixie`,
      { stdio: 'inherit' },
    );
  } finally {
    try {
      fs.rmSync(path.dirname(tmpEnvFile), { recursive: true, force: true });
    } catch {
      // best-effort cleanup; don't mask the underlying error
    }
  }

  return `postgresql://postgres:${password}@localhost:${port}/kici`;
}

export function registerOrchestratorInstall(orchestrator: Command): void {
  orchestrator
    .command('install')
    .description('Install the orchestrator as a system service')
    .option('--platform <type>', 'Service platform (systemd, launchd, windows, compose)')
    .option('--env-file <path>', 'Path to existing env/config file to use')
    .option('--binary <path>', 'Path to orchestrator binary (default: current executable)')
    .option('--dev', 'Dev mode: spin up PostgreSQL container on port 15432')
    .option('--wizard', 'Interactive wizard for guided setup')
    .option('--name <name>', 'Service name', 'kici-orchestrator')
    .option('--system', 'Install as system-level service (requires root)')
    .option('--user-level', 'Install as user-level service (no root required)')
    .option(
      '--user <name>',
      'Run the service as the named user (system-level launchd only; sets UserName in plist so the daemon drops privileges)',
    )
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
          component: 'orchestrator',
          isUserLevel: userLevel,
          kiciRoot,
          manager,
        });
        const existing = existingInstances.find((c) => c.name === serviceName);
        if (existing && existing.instanceDir !== instanceDir && !opts.force) {
          const at = existing.instanceDir ?? '(no manifest)';
          console.error(
            `Error: an orchestrator instance "${serviceName}" is already installed at ${at}.\n` +
              `\n` +
              `Upgrading this service? Don't re-run install — installing again is for first-time\n` +
              `setup, not upgrades. For an npm-global install run \`npm install -g kici-admin@latest\`\n` +
              `then \`kici-admin orchestrator restart\`; for a versioned-directory install run\n` +
              `\`kici-admin orchestrator upgrade\`.\n` +
              `\n` +
              `Installing a second, separate instance? Pass a different --name or --instance-dir,\n` +
              `or --force to take over this one.`,
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

        // Handle --dev mode: spin up Postgres container
        let devDbUrl: string | undefined;
        if (opts.dev) {
          const containerName = `${serviceName}-dev-pg`;
          devDbUrl = startDevPostgres(containerName);
          console.log(`Dev PostgreSQL URL: ${devDbUrl}`);
        }

        // Handle wizard mode
        if (opts.wizard) {
          const { runOrchestratorWizard } = await import('../../wizard/orchestrator-wizard.js');
          const wizardConfig = await runOrchestratorWizard();
          let envContent = '# KiCI orchestrator configuration (generated by setup wizard)\n';
          envContent += `KICI_MODE=${wizardConfig.mode}\n`;
          envContent += `KICI_DATABASE_URL=${wizardConfig.databaseUrl}\n`;
          envContent += `KICI_PORT=${wizardConfig.port}\n`;
          envContent += `KICI_SECRET_KEY=${wizardConfig.secretsKey}\n`;
          envContent += `KICI_BOOTSTRAP_ADMIN_TOKEN=${wizardConfig.bootstrapAdminToken}\n`;
          if (wizardConfig.platformUrl)
            envContent += `KICI_PLATFORM_URL=${wizardConfig.platformUrl}\n`;
          if (wizardConfig.platformToken)
            envContent += `KICI_PLATFORM_TOKEN=${wizardConfig.platformToken}\n`;
          fs.writeFileSync(envFilePath, envContent, 'utf-8');
          console.log(`Wrote wizard configuration to ${envFilePath}`);
        } else if (opts.envFile) {
          // Copy provided env file to config directory
          const source = path.resolve(opts.envFile);
          if (!fs.existsSync(source)) {
            console.error(`Error: env file not found: ${source}`);
            process.exit(1);
          }
          fs.copyFileSync(source, envFilePath);
          console.log(`Copied env file to ${envFilePath}`);
        } else if (!fs.existsSync(envFilePath)) {
          // Create a minimal env file
          let envContent = `# KiCI orchestrator configuration\n# See docs for all available options\n`;
          if (devDbUrl) {
            envContent += `KICI_DATABASE_URL=${devDbUrl}\n`;
          }
          fs.writeFileSync(envFilePath, envContent, 'utf-8');
          console.log(`Created env file at ${envFilePath}`);
        } else if (devDbUrl) {
          // Append KICI_DATABASE_URL to existing env file
          fs.appendFileSync(envFilePath, `\nKICI_DATABASE_URL=${devDbUrl}\n`);
          console.log(`Appended KICI_DATABASE_URL to ${envFilePath}`);
        }

        // Inject the deployment-identity env vars so the running orchestrator
        // can report its own deployment shape in source.register (drives the
        // dashboard's per-orchestrator kici-admin command helper). For compose,
        // resolve the container runtime; a probe failure yields no runtime line
        // rather than aborting the install. Idempotent: re-install replaces any
        // existing KICI_DEPLOY_* lines.
        let composeRuntime: 'podman' | 'docker' | undefined;
        if (platform === 'compose') {
          try {
            composeRuntime = detectRuntime();
          } catch {
            composeRuntime = undefined;
          }
        }
        const deployLines = buildDeployEnvLines({
          platform,
          serviceName,
          containerRuntime: composeRuntime,
        });
        fs.writeFileSync(
          envFilePath,
          upsertDeployEnvLines(fs.readFileSync(envFilePath, 'utf-8'), deployLines),
          'utf-8',
        );

        // Resolve the run command. With an explicit --binary we run it
        // directly (assumed self-launching). Otherwise we run Node against the
        // installed orchestrator server entry — server.js for platform/hybrid,
        // standalone.js for independent — because `npm install -g kici-admin`
        // exposes only the CLI bin, not a self-launching server binary.
        const entryScript = opts.binary
          ? undefined
          : fileURLToPath(
              import.meta.resolve(
                `@kici-dev/orchestrator/${selectServerEntry(fs.readFileSync(envFilePath, 'utf-8'))}`,
              ),
            );
        const { executablePath, args } = resolveServiceExecutable({
          binary: opts.binary ? path.resolve(opts.binary) : undefined,
          nodePath: process.execPath,
          entryScript,
        });

        // Check for Firecracker scaler in env file and warn if non-root
        if (userLevel) {
          try {
            const envContent = fs.readFileSync(envFilePath, 'utf-8');
            if (envContent.includes('firecracker') || envContent.includes('FIRECRACKER')) {
              console.warn('\nWARNING: Firecracker scaler requires root privileges.');
              console.warn(
                'The service is being installed at user level. Firecracker will not work.',
              );
              console.warn('Re-run as root (sudo) to install a system-level service.\n');
            }
          } catch {
            // Ignore read errors
          }
        }

        // Build ServiceConfig
        const config: ServiceConfig = {
          name: serviceName,
          displayName: 'KiCI Orchestrator',
          description: 'KiCI CI/CD workflow orchestrator service',
          executablePath,
          args,
          // The node running this install command is the node the spawned
          // agents use; bake its bin dir onto the service PATH so the
          // required-tools check passes even when --binary wraps node.
          nodeBinDir: path.dirname(process.execPath),
          envFilePath,
          workingDirectory: configDir,
          isUserLevel: userLevel,
          user: opts.user,
          component: 'orchestrator',
          instanceDir,
          restartPolicy: DEFAULT_RESTART_POLICY,
        };

        await manager.install(config);

        // Write the instance manifest into the deploy folder. This is the
        // single source of truth every lifecycle command reads to reconstruct
        // the ServiceConfig without re-deriving paths.
        const manifest: InstanceManifest = {
          component: 'orchestrator',
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
            component: 'orchestrator',
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

        console.log(`\nOrchestrator service "${serviceName}" installed successfully.`);
        console.log(`  Config:   ${envFilePath}`);
        console.log(`  Logs:     ${logDir}`);
        console.log(`  Manifest: ${manifestFile}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Edit ${envFilePath} with your configuration`);
        console.log(`  2. Run \`kici-admin orchestrator start\` to start the service`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
