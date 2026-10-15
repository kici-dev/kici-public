/**
 * `kici-admin orchestrator install`: registers the orchestrator as a native
 * service, auto-detecting platform and privilege level.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import {
  assertServerResolvable,
  resolveServerScript,
  resolveServiceExecutable,
  selectServerEntry,
  type ModuleResolver,
} from '../../service/entrypoint.js';
import { buildDeployEnvLines, upsertDeployEnvLines } from '../../service/deploy-env.js';
import { detectRuntime } from '../../service/compose.js';
import type { InstanceManifest, ServiceConfig, ServicePlatform } from '../../service/index.js';
import { getInstallBase } from '../shared/versioned-upgrade.js';
import { resolveWizardMode, writeInstallEnvFile, DEFAULT_INSTALL_MODE } from './install-env.js';
import { OrchestratorMode } from '@kici-dev/engine';
import { formatSourceAddHint } from '../../wizard/orchestrator-wizard.js';
import { kiciMkdtemp } from '@kici-dev/shared';
import { isCiEnvironment } from '@kici-dev/shared/ci-env';
import { cliAction } from '../shared/cli-action.js';

interface InstallOptions {
  platform?: ServicePlatform;
  mode?: string;
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

/** Start a dev PostgreSQL container (Podman or Docker); returns its DATABASE_URL. */
function startDevPostgres(containerName: string): string {
  const password = crypto.randomBytes(16).toString('hex');
  const port = 15432;

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
  // POSTGRES_PASSWORD goes via a 0600 --env-file, not argv, so it never lands
  // in `ps aux` or shell history; the finally removes it, so the plaintext
  // window is the moment podman takes to read it. POSTGRES_DB is not sensitive.
  const tmpEnvFile = path.join(kiciMkdtemp('kici-dev-pg-'), 'postgres.env');
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
    .addHelpText(
      'after',
      `
Token vocabulary:
  KICI_PLATFORM_TOKEN is an orchestrator REGISTRATION token (kici_ok_...), minted
  in the dashboard (Settings -> Orchestrators -> New orchestrator). It authorises a
  single orchestrator to connect to the Platform relay.

  It is NOT a cluster JOIN token (kici_join_v1....). Join tokens are used only by
  \`kici-admin join\` to add another orchestrator as a peer to an existing cluster.
`,
    )
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: detected from the host',
    )
    .option(
      '--mode <mode>',
      `Operating mode written to the env file (${OrchestratorMode.options.join(', ')}). Naming it with --env-file overwrites the copied file's own KICI_MODE; omitting it leaves that value alone`,
      DEFAULT_INSTALL_MODE,
    )
    .option('--env-file <path>', 'Path to existing env/config file to use')
    .option('--binary <path>', 'Path to orchestrator binary (default: current executable)')
    .option('--dev', 'Dev mode: spin up PostgreSQL container on port 15432')
    .option('--wizard', 'Run the interactive setup wizard (default on an interactive terminal)')
    .option('--no-wizard', 'Skip the wizard and write a stub env file to edit by hand')
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
    .action(
      cliAction(async (opts: InstallOptions, command: Command) => {
        // A standalone-package kici-admin has no import.meta.resolve: without
        // --binary it cannot locate the server, so it stops before the wizard
        // or any file.
        const resolveModule: ModuleResolver | undefined =
          typeof import.meta.resolve === 'function'
            ? (specifier) => import.meta.resolve(specifier)
            : undefined;
        assertServerResolvable('orchestrator', opts.binary, resolveModule);
        if (opts.wizard === true && opts.envFile) {
          console.error('Error: Cannot use --wizard with --env-file');
          process.exit(1);
        }
        if (opts.wizard === true && opts.dev) {
          console.error(
            'Error: Cannot use --wizard with --dev (the wizard prompts for the database URL)',
          );
          process.exit(1);
        }
        const parsedMode = OrchestratorMode.safeParse(opts.mode);
        if (!parsedMode.success) {
          console.error(
            `Error: --mode must be one of: ${OrchestratorMode.options.join(', ')} (got "${opts.mode}")`,
          );
          process.exit(1);
        }
        const orchestratorMode = parsedMode.data;
        // --mode has a Commander default; only the option source tells a typed
        // `--mode independent` from nothing, and the env-file path needs that.
        const modeExplicit = command.getOptionValueSource('mode') !== 'default';

        const platform = detectPlatform(opts.platform as ServicePlatform | undefined);
        const userLevel = resolveUserLevel(opts);
        const serviceName = opts.name;
        const instanceDir = path.resolve(opts.instanceDir ?? process.cwd());
        const kiciRoot = kiciConfigRoot(userLevel);

        console.log(`Platform: ${platform}`);
        console.log(`Privilege: ${userLevel ? 'user' : 'system'}`);
        console.log(`Service name: ${serviceName}`);
        console.log(`Instance dir: ${instanceDir}`);

        // Created early so the create-path guard can reconcile the index
        // against the driver's native scan.
        const manager = await createServiceManager(platform);

        // Create-path guard: refuse to clobber a same-named foreign instance
        // (installed at a different path, or in the init system with no
        // manifest yet); --force overrides. The scan covers every candidate
        // driver, so a same-named compose orchestrator on a systemd host counts.
        const existingInstances = await listInstances({
          component: 'orchestrator',
          isUserLevel: userLevel,
          kiciRoot,
        });
        const existing = existingInstances.find((c) => c.name === serviceName);
        if (existing && existing.instanceDir !== instanceDir && !opts.force) {
          const at = existing.instanceDir ?? '(no manifest)';
          console.error(
            `Error: an orchestrator instance "${serviceName}" is already installed at ${at}.\n` +
              `\n` +
              `Upgrading this service? Don't re-run install — installing again is for first-time\n` +
              `setup, not upgrades. For an npm-global install run\n` +
              `\`kici-admin orchestrator upgrade --version <version>\`; for a versioned-directory install\n` +
              `run \`kici-admin orchestrator upgrade --from <archive> --version <version>\`.\n` +
              `\n` +
              `Installing a second, separate instance? Pass a different --name or --instance-dir,\n` +
              `or --force to take over this one.`,
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

        let devDbUrl: string | undefined;
        if (opts.dev) {
          const containerName = `${serviceName}-dev-pg`;
          devDbUrl = startDevPostgres(containerName);
          console.log(`Dev PostgreSQL URL: ${devDbUrl}`);
        }

        // The env file comes from the wizard on a bare interactive TTY, an
        // explicit --env-file copy, or an enumerated stub for every
        // non-interactive/scripted install.
        const envMode = resolveWizardMode({
          wizard: opts.wizard,
          envFile: opts.envFile,
          dev: opts.dev,
          isTTY: Boolean(process.stdout.isTTY),
          isCI: isCiEnvironment(),
        });
        const envResult = await writeInstallEnvFile({
          mode: envMode,
          envFilePath,
          envFileSource: opts.envFile,
          devDbUrl,
          orchestratorMode,
          modeExplicit,
        });

        // Deployment-identity env vars let the orchestrator report its shape in
        // source.register (the dashboard's per-orchestrator kici-admin command
        // helper). A compose runtime probe failure yields no runtime line rather
        // than aborting. Re-install replaces existing KICI_DEPLOY_* lines.
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
          envFilePath,
        });
        fs.writeFileSync(
          envFilePath,
          upsertDeployEnvLines(fs.readFileSync(envFilePath, 'utf-8'), deployLines),
          'utf-8',
        );

        // An explicit --binary runs directly (assumed self-launching). Otherwise
        // Node runs the server entry (server.js for platform/hybrid,
        // standalone.js for independent), because `npm install -g kici-admin`
        // exposes only the CLI bin, not a self-launching server binary.
        const entryScript = opts.binary
          ? undefined
          : resolveServerScript(
              `@kici-dev/orchestrator/${selectServerEntry(fs.readFileSync(envFilePath, 'utf-8'))}`,
              'orchestrator',
              resolveModule,
            );
        const { executablePath, args } = resolveServiceExecutable({
          binary: opts.binary ? path.resolve(opts.binary) : undefined,
          nodePath: process.execPath,
          entryScript,
        });

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
            // Unreadable env file: no warning.
          }
        }

        const config: ServiceConfig = {
          name: serviceName,
          ...SERVICE_TEXT.orchestrator,
          executablePath,
          args,
          // The node running install is the node spawned agents use; its bin
          // dir on the service PATH passes the required-tools check even when
          // --binary wraps node.
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

        // The manifest is the single source of truth lifecycle commands read to
        // rebuild the ServiceConfig. A re-install updates it in place, keeping
        // migration heads and creation time and recording the launcher's version.
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
        const { file: manifestFile, warning: manifestWarning } = writeInstallManifest(
          instanceDir,
          manifest,
          { execPath: executablePath, args },
        );
        if (manifestWarning) console.warn(`Warning: ${manifestWarning}`);

        try {
          appendIndexEntry(kiciRoot, {
            component: 'orchestrator',
            name: serviceName,
            platform,
            isUserLevel: userLevel,
            instanceDir,
          });
        } catch (err) {
          // appendIndexEntry throws on a same-name-different-dir collision; the
          // unit is already installed, so warn loudly rather than tear it down.
          console.warn(`Warning: instance index append failed: ${(err as Error).message}`);
        }

        console.log(`\nOrchestrator service "${serviceName}" installed successfully.`);
        console.log(`  Config:   ${envFilePath}`);
        console.log(`  Logs:     ${logDir}`);
        console.log(`  Manifest: ${manifestFile}`);
        console.log(`\nNext steps:`);
        if (envMode === 'stub') {
          console.log(
            `  1. Edit ${envFilePath} — it lists the required keys with generation commands.`,
          );
          console.log(`  2. Run \`kici-admin orchestrator start\` to start the service`);
        } else {
          console.log(`  1. Run \`kici-admin orchestrator start\` to start the service`);
        }
        console.log(`  Schedule daily database backups: \`kici-admin db backup --install-timer\``);
        if (envResult.sourceHint) {
          // A sourceHint is only ever produced by the wizard (non-stub) path,
          // which prints a single "1. start" step above, so this is step 2.
          console.log(
            `  2. Add the GitHub App source you configured (run after the orchestrator is up):`,
          );
          for (const line of formatSourceAddHint(envResult.sourceHint)) {
            console.log(line);
          }
        }
      }),
    );
}
