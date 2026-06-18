/**
 * kici hook command
 *
 * Install and manage pre-commit hooks for kici compile.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { select } from '@inquirer/prompts';
import { logger, toErrorMessage } from '@kici-dev/core';
import { detectHookTools, installHook, findGitDir } from '../hooks/index.js';
import type { HookToolName } from '../hooks/index.js';

/**
 * Options for hook install command
 */
export interface HookInstallOptions {
  /** Force raw git hook (ignore detected tools) */
  git?: boolean;
}

/**
 * Install pre-commit hook for kici compile.
 *
 * @param options - Command options
 * @returns true on success, false on error
 */
export async function hookInstallCommand(options: HookInstallOptions = {}): Promise<boolean> {
  // Check if in git repo
  const gitDir = await findGitDir();
  if (!gitDir) {
    logger.error(pc.red('Error: Not in a git repository.'));
    logger.error(pc.gray('Run this command from within a git repository.'));
    return false;
  }

  try {
    // Determine which tool to use
    let selectedTool: HookToolName;

    if (options.git) {
      // Force raw git hook
      selectedTool = 'git';
    } else {
      // Detect tools
      const tools = await detectHookTools();

      if (tools.length === 0) {
        // No tool detected - use raw git hook or ask
        if (process.stdout.isTTY && process.env.CI !== 'true') {
          const choice = await select({
            message: 'No pre-commit tool detected. How would you like to install the hook?',
            choices: [
              { name: 'Raw git hook (.git/hooks/pre-commit)', value: 'git' },
              { name: 'Skip installation', value: 'skip' },
            ],
          });

          if (choice === 'skip') {
            logger.info(pc.yellow('Hook installation skipped.'));
            return true;
          }
          selectedTool = choice as HookToolName;
        } else {
          // Non-interactive: skip
          logger.info(pc.yellow('No pre-commit tool detected. Use --git to install raw git hook.'));
          return true;
        }
      } else if (tools.length === 1) {
        selectedTool = tools[0].name;
        logger.info(pc.gray(`Detected ${selectedTool}, installing hook...`));
      } else {
        // Multiple tools - let user choose in interactive mode
        if (process.stdout.isTTY && process.env.CI !== 'true') {
          const tool = await select({
            message: 'Multiple pre-commit tools detected. Which would you like to use?',
            choices: tools.map((t) => ({
              name: t.name,
              value: t.name,
            })),
          });
          selectedTool = tool as HookToolName;
        } else {
          // Non-interactive: use highest priority
          selectedTool = tools[0].name;
          logger.info(pc.gray(`Using ${selectedTool} (highest priority)`));
        }
      }
    }

    // Detect if local Verdaccio is in use (via .kici/.npmrc)
    const useVerdaccio = await detectVerdaccioNpmrc();

    // Install the hook
    const result = await installHook(selectedTool, { useVerdaccio });

    if (result.success) {
      if (result.action === 'skipped') {
        logger.info(pc.yellow(`Already installed: ${result.message}`));
      } else {
        logger.info(pc.green(`Hook installed: ${result.message}`));
      }
      return true;
    } else {
      logger.error(pc.red(`Error: ${result.message}`));
      return false;
    }
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`Error: ${message}`));
    return false;
  }
}

/**
 * Detect if local Verdaccio is configured by checking for .kici/.npmrc
 */
async function detectVerdaccioNpmrc(): Promise<boolean> {
  try {
    const npmrcPath = path.resolve('.kici', '.npmrc');
    const content = await readFile(npmrcPath, 'utf-8');
    return content.includes('verdaccio');
  } catch {
    return false;
  }
}
