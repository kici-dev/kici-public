import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { HookToolName } from './detector.js';
import { findGitDir } from './detector.js';
import { getHookTemplate, hasKiciHook } from './templates.js';

const execAsync = promisify(exec);

async function runCommand(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, { cwd, timeout: 30_000 });
  return stdout.trim();
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export interface InstallResult {
  readonly success: boolean;
  readonly tool: HookToolName;
  readonly path: string; // the modified file
  readonly action: 'created' | 'updated' | 'skipped';
  readonly message: string;
}

export interface InstallOptions {
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Use @kici-dev/compiler from local Verdaccio instead of the public kici package. */
  useVerdaccio?: boolean;
}

/**
 * Installs the kici compile hook through each tool's own CLI, writing the files
 * by hand only when that CLI is unavailable.
 */
export async function installHook(
  tool: HookToolName,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const cwd = options.cwd ?? process.cwd();
  const npxCmd = options.useVerdaccio ? 'npx -y @kici-dev/compiler@latest' : 'npx -y kici@latest';
  const command = `${npxCmd} compile && git add .kici/kici.lock.json`;

  switch (tool) {
    case 'husky':
      return installHuskyHook(cwd, command);
    case 'lefthook':
      return installLefthookHook(cwd, command);
    case 'pre-commit':
    case 'prek':
      return installPreCommitHook(cwd, command, tool);
    case 'git':
      return installGitHook(cwd, command);
    default:
      return {
        success: false,
        tool,
        path: '',
        action: 'skipped',
        message: `Unknown hook tool: ${tool}`,
      };
  }
}

/**
 * Initializes husky when `.husky/` is missing, then creates `.husky/pre-commit`
 * or appends the command to it.
 */
async function installHuskyHook(cwd: string, command: string): Promise<InstallResult> {
  const hookDir = path.join(cwd, '.husky');
  const hookPath = path.join(hookDir, 'pre-commit');
  const template = getHookTemplate('husky');

  try {
    const huskyReady = await dirExists(hookDir);
    let freshInit = false;

    if (!huskyReady) {
      freshInit = await initHusky(cwd, hookDir);
    }

    let content = '';
    let action: 'created' | 'updated' = 'created';

    try {
      content = await readFile(hookPath, 'utf-8');

      if (hasKiciHook(content)) {
        return {
          success: true,
          tool: 'husky',
          path: hookPath,
          action: 'skipped',
          message: 'kici hook already installed',
        };
      }

      if (freshInit) {
        // `husky init` writes a default pre-commit: replace it.
        content = template.getFullScript!(command);
        action = 'created';
      } else {
        content += template.getCommand(command);
        action = 'updated';
      }
    } catch {
      content = template.getFullScript!(command);
    }

    await writeFile(hookPath, content, 'utf-8');
    try {
      await chmod(hookPath, 0o755);
    } catch {
      /* chmod not supported on Windows — husky handles it */
    }

    return {
      success: true,
      tool: 'husky',
      path: hookPath,
      action,
      message:
        action === 'created'
          ? 'Created .husky/pre-commit with kici compile'
          : 'Added kici compile to .husky/pre-commit',
    };
  } catch (err) {
    return {
      success: false,
      tool: 'husky',
      path: hookPath,
      action: 'skipped',
      message: `Failed to install husky hook: ${(err as Error).message}`,
    };
  }
}

/** Returns true when this call initialized husky. */
async function initHusky(cwd: string, hookDir: string): Promise<boolean> {
  try {
    // Creates .husky/ and a default pre-commit, and sets core.hooksPath.
    await runCommand('npx --yes husky init', cwd);
    return true;
  } catch {
    await mkdir(hookDir, { recursive: true });
    try {
      await runCommand('git config core.hooksPath .husky', cwd);
    } catch {
      /* not in a git repo or git unavailable */
    }
    return true;
  }
}

/** Adds the kici-compile command to the lefthook config, then runs `npx lefthook install`. */
async function installLefthookHook(cwd: string, command: string): Promise<InstallResult> {
  const configFiles = ['lefthook.yml', '.lefthook.yml', '.config/lefthook.yml'];
  let configPath = '';
  let content = '';

  for (const file of configFiles) {
    const filePath = path.join(cwd, file);
    try {
      content = await readFile(filePath, 'utf-8');
      configPath = filePath;
      break;
    } catch {
      // Try the next location.
    }
  }

  if (!configPath) {
    configPath = path.join(cwd, 'lefthook.yml');
    content = `# Lefthook configuration
# https://lefthook.dev/configuration/

pre-commit:
  parallel: true
  commands:
`;
  }

  if (hasKiciHook(content)) {
    return {
      success: true,
      tool: 'lefthook',
      path: configPath,
      action: 'skipped',
      message: 'kici hook already installed',
    };
  }

  const template = getHookTemplate('lefthook');
  const hookConfig = template.getCommand(command);

  if (content.includes('pre-commit:')) {
    // Only the pre-commit section, up to the next top-level key: `commands:`
    // under another hook such as commit-msg must not match.
    const preCommitIdx = content.indexOf('pre-commit:');
    const restAfterKey = content.slice(preCommitIdx + 'pre-commit:'.length);
    const nextTopLevelMatch = restAfterKey.match(/\n[a-zA-Z]/);
    const sectionEnd = nextTopLevelMatch?.index ?? restAfterKey.length;
    const preCommitSection = restAfterKey.slice(0, sectionEnd);

    if (preCommitSection.includes('commands:')) {
      content = content.replace(/(pre-commit:[\s\S]*?commands:)/, `$1\n${hookConfig}`);
    } else {
      content = content.replace(/(pre-commit:.*)/, `$1\n  commands:\n${hookConfig}`);
    }
  } else {
    content += `\npre-commit:\n  parallel: true\n  commands:\n${hookConfig}\n`;
  }

  try {
    await writeFile(configPath, content, 'utf-8');

    try {
      await runCommand('npx lefthook install', cwd);
    } catch {
      /* lefthook CLI not available — config is written, user can run `lefthook install` manually */
    }

    return {
      success: true,
      tool: 'lefthook',
      path: configPath,
      action: 'updated',
      message: 'Added kici-compile command to lefthook.yml',
    };
  } catch (err) {
    return {
      success: false,
      tool: 'lefthook',
      path: configPath,
      action: 'skipped',
      message: `Failed to update lefthook config: ${(err as Error).message}`,
    };
  }
}

/**
 * Both tools read `.pre-commit-config.yaml`. After editing it, runs
 * `pre-commit install` or `prek install`.
 */
async function installPreCommitHook(
  cwd: string,
  command: string,
  tool: 'pre-commit' | 'prek',
): Promise<InstallResult> {
  const configPath = path.join(cwd, '.pre-commit-config.yaml');
  let content = '';

  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    content = `# pre-commit configuration
# https://pre-commit.com/

repos:
`;
  }

  if (hasKiciHook(content)) {
    return {
      success: true,
      tool,
      path: configPath,
      action: 'skipped',
      message: 'kici hook already installed',
    };
  }

  const template = getHookTemplate(tool);
  const hookConfig = template.getCommand(command);

  if (content.includes('repos:')) {
    content = content.replace(/(repos:)/, `$1\n${hookConfig}`);
  } else {
    content += `repos:\n${hookConfig}\n`;
  }

  try {
    await writeFile(configPath, content, 'utf-8');

    const installCmd = tool === 'prek' ? 'prek install' : 'pre-commit install';
    try {
      await runCommand(installCmd, cwd);
    } catch {
      /* CLI not available — config is written, user can run install manually */
    }

    return {
      success: true,
      tool,
      path: configPath,
      action: 'updated',
      message: `Added kici hook to .pre-commit-config.yaml`,
    };
  } catch (err) {
    return {
      success: false,
      tool,
      path: configPath,
      action: 'skipped',
      message: `Failed to update pre-commit config: ${(err as Error).message}`,
    };
  }
}

/**
 * A worktree's `commondir` file names the shared git directory. Git reads hooks
 * only from the common `hooks/`, never from `.git/worktrees/<name>/hooks/`.
 */
async function resolveCommonGitDir(gitDir: string): Promise<string> {
  try {
    const commondirPath = path.join(gitDir, 'commondir');
    const commondir = (await readFile(commondirPath, 'utf-8')).trim();
    return path.resolve(gitDir, commondir);
  } catch {
    // Not a worktree: gitDir is already the common dir.
    return gitDir;
  }
}

/** Creates or appends to the common git directory's `hooks/pre-commit`. */
async function installGitHook(cwd: string, command: string): Promise<InstallResult> {
  const gitDir = await findGitDir(cwd);

  if (!gitDir) {
    return {
      success: false,
      tool: 'git',
      path: '',
      action: 'skipped',
      message: 'Not in a git repository',
    };
  }

  const commonGitDir = await resolveCommonGitDir(gitDir);
  const hookDir = path.join(commonGitDir, 'hooks');
  const hookPath = path.join(hookDir, 'pre-commit');
  const template = getHookTemplate('git');

  try {
    await mkdir(hookDir, { recursive: true });

    let content = '';
    let action: 'created' | 'updated' = 'created';

    try {
      content = await readFile(hookPath, 'utf-8');
      action = 'updated';

      if (hasKiciHook(content)) {
        return {
          success: true,
          tool: 'git',
          path: hookPath,
          action: 'skipped',
          message: 'kici hook already installed',
        };
      }
    } catch {
      content = template.getFullScript!(command);
      await writeFile(hookPath, content, 'utf-8');
      await chmod(hookPath, 0o755);

      return {
        success: true,
        tool: 'git',
        path: hookPath,
        action: 'created',
        message: 'Created .git/hooks/pre-commit with kici compile',
      };
    }

    content += template.getCommand(command);
    await writeFile(hookPath, content, 'utf-8');
    await chmod(hookPath, 0o755);

    return {
      success: true,
      tool: 'git',
      path: hookPath,
      action,
      message: 'Added kici compile to .git/hooks/pre-commit',
    };
  } catch (err) {
    return {
      success: false,
      tool: 'git',
      path: hookPath,
      action: 'skipped',
      message: `Failed to install git hook: ${(err as Error).message}`,
    };
  }
}
