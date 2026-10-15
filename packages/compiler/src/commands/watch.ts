import path from 'node:path';
import pc from 'picocolors';
import chokidar from 'chokidar';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveKiciDir } from '../execution/index.js';
import { compileCommand, type CompileOptions } from './compile.js';

const DEBOUNCE_MS = 200;

/**
 * Recompile on workflow changes: clears the terminal per recompile (like
 * tsc --watch), debounces changes, never compiles concurrently, and shuts down
 * on SIGINT/SIGTERM.
 */
export async function watchCommand(options: Omit<CompileOptions, 'check'>): Promise<void> {
  const kiciDir = resolveKiciDir(options.kiciDir);
  const workflowDir = path.join(kiciDir, 'workflows');
  let debounceTimeout: NodeJS.Timeout | null = null;
  let isCompiling = false;
  let pendingRecompile = false;

  /** A call during a compile schedules one recompile after it, so no change is dropped. */
  const compile = async (initial = false): Promise<void> => {
    if (isCompiling) {
      pendingRecompile = true;
      return;
    }

    isCompiling = true;
    pendingRecompile = false;

    if (!initial) {
      console.clear();
    }

    const timestamp = new Date().toLocaleTimeString();
    logger.debug(pc.dim(`[${timestamp}] Compiling...`));

    try {
      const success = await compileCommand({
        kiciDir: options.kiciDir,
        check: false, // always write in watch mode
        verbose: options.verbose,
      });

      if (success) {
        logger.debug(pc.dim(`\n[${timestamp}] Watching for file changes...`));
      } else {
        logger.debug(pc.dim(`\n[${timestamp}] Fix errors and save to recompile...`));
      }
    } catch (error: unknown) {
      // compileCommand handles its own errors; this is unexpected.
      logger.error(pc.red('Unexpected error:'), toErrorMessage(error));
      logger.debug(pc.dim(`\n[${timestamp}] Watching for file changes...`));
    } finally {
      isCompiling = false;

      if (pendingRecompile) {
        pendingRecompile = false;
        compile();
      }
    }
  };

  await compile(true);

  const watcher = chokidar.watch(path.join(workflowDir, '*.ts'), {
    persistent: true,
    // Handles atomic saves.
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
    // Already compiled.
    ignoreInitial: true,
  });

  const handleChange = () => {
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
    }

    debounceTimeout = setTimeout(() => {
      compile();
    }, DEBOUNCE_MS);
  };

  watcher.on('change', handleChange);
  watcher.on('add', handleChange);
  watcher.on('unlink', handleChange);

  watcher.on('error', (error: unknown) => {
    logger.error(pc.red('Watch error:'), toErrorMessage(error));
  });

  logger.debug(pc.dim(`\nWatching for file changes...`));
  logger.debug(pc.dim(`Press Ctrl+C to stop.\n`));

  const shutdown = async (): Promise<void> => {
    logger.debug(pc.dim('\nShutting down...'));

    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
    }

    await watcher.close();

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // `persistent: true` keeps the event loop alive.
}
