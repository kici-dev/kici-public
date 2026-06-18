import path from 'node:path';
import pc from 'picocolors';
import chokidar from 'chokidar';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveKiciDir } from '../execution/index.js';
import { compileCommand, type CompileOptions } from './compile.js';

/** Debounce delay in milliseconds */
const DEBOUNCE_MS = 200;

/**
 * Run compiler in watch mode.
 *
 * Features:
 * - Clears terminal on each recompile (like tsc --watch)
 * - Debounces rapid file changes (200ms)
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Prevents concurrent compilation
 *
 * @param options - Compile options (kiciDir, verbose flag)
 */
export async function watchCommand(options: Omit<CompileOptions, 'check'>): Promise<void> {
  const kiciDir = resolveKiciDir(options.kiciDir);
  const workflowDir = path.join(kiciDir, 'workflows');
  let debounceTimeout: NodeJS.Timeout | null = null;
  let isCompiling = false;
  let pendingRecompile = false;

  /**
   * Run a compilation cycle.
   * If called while already compiling, sets a flag to recompile after the
   * current compilation finishes (prevents dropped file changes).
   */
  const compile = async (initial = false): Promise<void> => {
    // Prevent concurrent compilation — schedule recompile after current finishes
    if (isCompiling) {
      pendingRecompile = true;
      return;
    }

    isCompiling = true;
    pendingRecompile = false;

    // Clear terminal (like tsc --watch)
    if (!initial) {
      console.clear();
    }

    const timestamp = new Date().toLocaleTimeString();
    logger.debug(pc.dim(`[${timestamp}] Compiling...`));

    try {
      const success = await compileCommand({
        kiciDir: options.kiciDir,
        check: false, // Always write in watch mode
        verbose: options.verbose,
      });

      if (success) {
        logger.debug(pc.dim(`\n[${timestamp}] Watching for file changes...`));
      } else {
        logger.debug(pc.dim(`\n[${timestamp}] Fix errors and save to recompile...`));
      }
    } catch (error: unknown) {
      // Unexpected error - should not happen if compileCommand handles errors
      logger.error(pc.red('Unexpected error:'), toErrorMessage(error));
      logger.debug(pc.dim(`\n[${timestamp}] Watching for file changes...`));
    } finally {
      isCompiling = false;

      // If a file changed during compilation, recompile now
      if (pendingRecompile) {
        pendingRecompile = false;
        compile();
      }
    }
  };

  // Initial compilation
  await compile(true);

  // Set up file watcher for entire .kici/workflows/ directory
  const watcher = chokidar.watch(path.join(workflowDir, '*.ts'), {
    persistent: true,
    // Wait for file writes to complete (handles atomic saves)
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
    // Ignore initial add event (we already compiled)
    ignoreInitial: true,
  });

  // Handle file changes (change, add, unlink) with debouncing
  const handleChange = () => {
    // Clear any pending debounce timer
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
    }

    // Set new debounce timer
    debounceTimeout = setTimeout(() => {
      compile();
    }, DEBOUNCE_MS);
  };

  watcher.on('change', handleChange);
  watcher.on('add', handleChange);
  watcher.on('unlink', handleChange);

  // Handle watcher errors
  watcher.on('error', (error: unknown) => {
    logger.error(pc.red('Watch error:'), toErrorMessage(error));
  });

  // Initial watch message
  logger.debug(pc.dim(`\nWatching for file changes...`));
  logger.debug(pc.dim(`Press Ctrl+C to stop.\n`));

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.debug(pc.dim('\nShutting down...'));

    // Clear pending debounce
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
    }

    // Close watcher
    await watcher.close();

    process.exit(0);
  };

  // Register signal handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  // The watcher already keeps the event loop running via persistent: true
}
