import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { PackageManager, detectPackageManagerSync } from '@kici-dev/core/package-manager';
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
import { SCHEMA_VERSION, BREAKING_FLOOR, type LockFile } from '../types.js';

/** Options for the compile command */
export interface CompileOptions {
  /** Path to .kici directory (defaults to .kici) */
  kiciDir?: string;
  /** Validate only, don't write lock file */
  check: boolean;
  /** Verbose output */
  verbose: boolean;
  /**
   * Suppress the success line on stdout (and the auto-types success line) so a
   * caller emitting machine-readable output keeps stdout pure. Validation
   * errors are still reported.
   */
  quiet?: boolean;
}

/**
 * Read the existing lock file and return its lockfileHash, if present.
 */
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
 * Reinstall dependencies in .kici/ using the project's package manager.
 *
 * Detects the manager from `.kici/` (pnpm-lock.yaml / yarn.lock /
 * package-lock.json) so a standalone-pnpm or -yarn `.kici` is reinstalled with
 * the right tool — running `npm ci` against a pnpm lock fails, and against a
 * stale npm lock left beside a pnpm lock it fails even harder.
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

/**
 * Execute the compile command.
 *
 * @param options - Command options
 * @returns true if successful, false if errors
 */
export async function compileCommand(options: CompileOptions): Promise<boolean> {
  const kiciDir = options.kiciDir ?? '.kici';
  const absoluteKiciDir = resolveKiciDir(kiciDir);

  if (options.verbose) {
    logger.debug(pc.dim(`Discovering workflows from ${absoluteKiciDir}/workflows/...`));
  }

  try {
    const lockPath = path.join(absoluteKiciDir, 'kici.lock.json');

    // 0. Check if deps changed since last compile — reinstall if so. Skip when
    // `.kici/package.json` is absent: that signals an externally-managed dep
    // graph (pnpm/yarn workspace member where deps install at the repo root),
    // so there is nothing to reinstall under `.kici/`. Running `npm install`
    // here would walk up and try to install the root workspace's
    // `workspace:*` refs with npm, which npm cannot resolve.
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

    // 1. Discover workflows from .kici/workflows/
    const { workflows: workflowsWithSource, workflowDir } =
      await discoverWorkflows(absoluteKiciDir);

    if (options.verbose) {
      logger.debug(pc.dim(`Found ${workflowsWithSource.length} workflow(s) in ${workflowDir}`));
    }

    // 2. Validate the workflows (source-carrying, for real error locations)
    const validation = validateConfig(workflowsWithSource);

    if (!validation.valid) {
      // Print all errors
      for (const error of validation.errors) {
        logger.error(formatError(error));
      }
      return false;
    }

    if (options.verbose) {
      logger.debug(pc.dim('Validation passed'));
    }

    // 3. Generate lock file (with source tracking for better references)
    const lockFile = generateLockFile(workflowsWithSource);
    const lockJson = serializeLockFile(lockFile);

    // Informational: when the current schema version is itself breaking, warn
    // that orchestrators older than it cannot read this lock. Silent otherwise
    // (older orchestrators down to the breaking floor still read it).
    const windowWarning = schemaWindowWarning(BREAKING_FLOOR, SCHEMA_VERSION);
    if (windowWarning) {
      logger.warn(pc.yellow(windowWarning));
    }

    // 4. Write lock file (unless --check)
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

      // Auto-regenerate types when authenticated against the Platform
      // (non-blocking). Requires a token, a Platform endpoint, and an active
      // org — the same context DashboardClient needs to reach the org's
      // contexts through the relay.
      try {
        const { loadGlobalConfig } = await import('../remote/config.js');
        const config = await loadGlobalConfig();
        const hasToken = Boolean(config.pat ?? config.token);
        const hasEndpoint = Boolean(config.platformEndpoint ?? config.endpoint);
        if (hasToken && hasEndpoint && config.activeOrgId) {
          const { typesCommand } = await import('./types.js');
          await typesCommand({ kiciDir: kiciDir, quiet: options.quiet });
        }
      } catch {
        // Non-blocking -- warn and continue
        logger.warn(
          pc.yellow('Could not refresh types (Platform unreachable). Compilation succeeded.'),
        );
      }
    } else {
      // --check: additionally run a tsc --noEmit type-check over the workflow
      // sources so type-broken workflows surface their errors at compile time.
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
      // Unexpected error
      logger.error(pc.red('error') + `: ${toErrorMessage(error)}`);
    }
    return false;
  }
}
