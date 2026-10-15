import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { PackageManager, detectPackageManagerSync } from '@kici-dev/core/package-manager';
import {
  findDigestReproducibilityWarnings,
  loadKiciIgnoreRules,
} from '@kici-dev/core/kici-source-digest';
import { discoverWorkflows, resolveKiciDir } from '../execution/index.js';
import { validateConfig, runTypecheck } from '../validation/index.js';
import {
  generateLockFile,
  serializeLockFile,
  detectGitRoot,
  computeLockfileHash,
  schemaWindowWarning,
} from '../lockfile/index.js';
import { formatError, isCompilerError } from '../errors/index.js';
import { SCHEMA_VERSION, type LockFile } from '../types.js';
import type { GlobalConfig } from '../remote/config.js';
import { resolveRunTarget } from '../remote/target.js';
import { hasLocalSecretFiles } from '../remote/types-sources.js';

export interface CompileOptions {
  /** Defaults to .kici */
  kiciDir?: string;
  /** Validate only; no lock file is written. */
  check: boolean;
  verbose: boolean;
  /**
   * Suppresses the success lines on stdout, so a caller emitting
   * machine-readable output keeps stdout pure; validation errors still print.
   */
  quiet?: boolean;
  /**
   * From `kici run remote`, so the types refresh reads the orchestrator the run
   * goes to.
   */
  orchestratorUrl?: string;
}

async function readExistingLockfileHash(lockPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const lock = JSON.parse(content) as LockFile;
    return lock.lockfileHash ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detects the package manager from `.kici/`'s lock file: `npm ci` fails against
 * a pnpm lock, and worse against a stale npm lock left beside one.
 */
async function reinstallDeps(kiciDir: string): Promise<void> {
  const pm = detectPackageManagerSync(kiciDir);
  const command =
    pm === PackageManager.Pnpm
      ? 'pnpm install'
      : pm === PackageManager.Yarn
        ? 'yarn install'
        : existsSync(path.join(kiciDir, 'package-lock.json'))
          ? 'npm ci'
          : 'npm install';
  logger.info('Running ' + pc.cyan(command) + ` in ${kiciDir}`);
  execSync(command, { cwd: kiciDir, stdio: 'inherit' });
}

export async function compileCommand(options: CompileOptions): Promise<boolean> {
  const kiciDir = options.kiciDir ?? '.kici';
  const absoluteKiciDir = resolveKiciDir(kiciDir);

  if (options.verbose) {
    logger.debug(pc.dim(`Discovering workflows from ${absoluteKiciDir}/workflows/...`));
  }

  try {
    const lockPath = path.join(absoluteKiciDir, 'kici.lock.json');

    // Reinstall when deps changed. A missing `.kici/package.json` means a
    // workspace member whose deps install at the repo root: `npm install` here
    // would walk up to `workspace:*` refs npm cannot resolve.
    if (existsSync(path.join(absoluteKiciDir, 'package.json'))) {
      const existingHash = await readExistingLockfileHash(lockPath);
      if (existingHash) {
        const gitRoot = detectGitRoot();
        const currentHash = computeLockfileHash(gitRoot);
        if (currentHash && currentHash !== existingHash) {
          logger.info(pc.yellow('Dependencies changed') + ' — reinstalling before compile...');
          await reinstallDeps(absoluteKiciDir);
        }
      }
    }

    const { workflows: workflowsWithSource, workflowDir } =
      await discoverWorkflows(absoluteKiciDir);

    if (options.verbose) {
      logger.debug(pc.dim(`Found ${workflowsWithSource.length} workflow(s) in ${workflowDir}`));
    }

    // Source-carrying, for real error locations.
    const validation = validateConfig(workflowsWithSource);

    if (!validation.valid) {
      for (const error of validation.errors) {
        logger.error(formatError(error));
      }
      return false;
    }

    if (options.verbose) {
      logger.debug(pc.dim('Validation passed'));
    }

    const lockFile = generateLockFile(workflowsWithSource);
    const lockJson = serializeLockFile(lockFile);

    // Warns only when minReaderVersion reaches SCHEMA_VERSION, so older
    // orchestrators cannot read the lock.
    const windowWarning = schemaWindowWarning(lockFile.minReaderVersion, SCHEMA_VERSION);
    if (windowWarning) {
      logger.warn(pc.yellow(windowWarning));
    }

    // A hand-written `.kici/.kiciignore` REPLACES the defaults, so a short one can
    // re-include a path the agent rewrites mid-run and move the contentHash every
    // run. Warn, not fail: the customer keeps control.
    const ignoreRules = await loadKiciIgnoreRules(absoluteKiciDir);
    for (const warning of ignoreRules.warnings) {
      logger.warn(pc.yellow(warning));
    }

    // This walks the tree. A hashed member the tarball omits or extraction
    // rewrites (a symlinked dependency tree, a link outside `.kici/`) yields a
    // lock the agent can never verify, whose drift error prescribes a remedy that
    // cannot work; warning here keeps it from being committed.
    for (const warning of await findDigestReproducibilityWarnings(absoluteKiciDir, ignoreRules)) {
      logger.warn(pc.yellow(warning));
    }

    if (!options.check) {
      await fs.writeFile(lockPath, lockJson, 'utf-8');

      if (!options.quiet) {
        logger.info(
          pc.green('✓') +
            ` Compiled workflows → .kici/kici.lock.json` +
            pc.dim(
              ` (${workflowsWithSource.length} workflow${workflowsWithSource.length !== 1 ? 's' : ''})`,
            ),
        );
      }

      // Non-blocking types refresh.
      try {
        const { loadGlobalConfig } = await import('../remote/config.js');
        const config = await loadGlobalConfig();
        if (
          await shouldRefreshTypes(config, absoluteKiciDir, process.env, options.orchestratorUrl)
        ) {
          const { typesCommand } = await import('./types.js');
          // The resolved directory, not the raw option: the declarations must
          // land where the `contentHash` tree's exclusion sees them.
          await typesCommand({
            kiciDir: absoluteKiciDir,
            quiet: options.quiet,
            orchestratorUrl: options.orchestratorUrl,
          });
        }
      } catch {
        logger.warn(pc.yellow('Could not refresh types. Compilation succeeded.'));
      }
    } else {
      // --check also runs a tsc --noEmit type-check over the workflow sources.
      const tc = await runTypecheck(absoluteKiciDir);
      if (tc.errors.length > 0) {
        for (const error of tc.errors) logger.error(formatError(error));
        return false;
      }
      if (!tc.ran && !options.quiet) {
        logger.info(pc.dim('Type-check skipped (no tsconfig.json — JavaScript mode)'));
      }
      if (!options.quiet) {
        logger.info(
          pc.green('✓') +
            ` Workflows are valid` +
            pc.dim(
              ` (${workflowsWithSource.length} workflow${workflowsWithSource.length !== 1 ? 's' : ''})`,
            ),
        );
      }
    }

    return true;
  } catch (error) {
    if (isCompilerError(error)) {
      logger.error(formatError(error));
    } else {
      logger.error(pc.red('error') + `: ${toErrorMessage(error)}`);
    }
    return false;
  }
}

/**
 * True for a direct orchestrator target, a Platform login with an active
 * organization, or a local secret file; a bare checkout skips the refresh.
 */
export async function shouldRefreshTypes(
  config: GlobalConfig,
  kiciDir: string,
  env: NodeJS.ProcessEnv = process.env,
  flagUrl?: string,
): Promise<boolean> {
  const resolved = resolveRunTarget({ flagUrl, env, config });
  if (resolved.ok && (resolved.target.kind === 'direct' || config.activeOrgId)) return true;
  return hasLocalSecretFiles(kiciDir);
}
