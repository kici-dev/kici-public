/** `kici hook`: pre-commit hooks that run `kici compile`. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { select } from '@inquirer/prompts';
import { logger, toErrorMessage } from '@kici-dev/core';
import { isCiEnvironment } from '@kici-dev/core/ci-env';
import { detectHookTools, installHook, findGitDir } from '../hooks/index.js';
import type { HookToolName } from '../hooks/index.js';

export interface HookInstallOptions {
  /** Force a raw git hook, ignoring detected tools. */
  git?: boolean;
}

export async function hookInstallCommand(options: HookInstallOptions = {}): Promise<boolean> {
  const gitDir = await findGitDir();
  if (!gitDir) {
    logger.error(pc.red('Error: Not in a git repository.'));
    logger.error(pc.gray('Run this command from within a git repository.'));
    return false;
  }

  try {
    let selectedTool: HookToolName;

    if (options.git) {
      selectedTool = 'git';
    } else {
      const tools = await detectHookTools();

      if (tools.length === 0) {
        if (process.stdout.isTTY && !isCiEnvironment()) {
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
          logger.info(pc.yellow('No pre-commit tool detected. Use --git to install raw git hook.'));
          return true;
        }
      } else if (tools.length === 1) {
        selectedTool = tools[0].name;
        logger.info(pc.gray(`Detected ${selectedTool}, installing hook...`));
      } else {
        if (process.stdout.isTTY && !isCiEnvironment()) {
          const tool = await select({
            message: 'Multiple pre-commit tools detected. Which would you like to use?',
            choices: tools.map((t) => ({
              name: t.name,
              value: t.name,
            })),
          });
          selectedTool = tool as HookToolName;
        } else {
          selectedTool = tools[0].name;
          logger.info(pc.gray(`Using ${selectedTool} (highest priority)`));
        }
      }
    }

    const useVerdaccio = await detectVerdaccioNpmrc();

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

/** A local Verdaccio registry is configured when `.kici/.npmrc` mentions it. */
async function detectVerdaccioNpmrc(): Promise<boolean> {
  try {
    const npmrcPath = path.resolve('.kici', '.npmrc');
    const content = await readFile(npmrcPath, 'utf-8');
    return content.includes('verdaccio');
  } catch {
    return false;
  }
}
