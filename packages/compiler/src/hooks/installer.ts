import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { HookToolName } from './detector.js';
import { findGitDir } from './detector.js';
import { getHookTemplate, hasKiciHook } from './templates.js';

const execAsync = promisify(exec);

/** Run a shell command in a directory. Returns stdout on success. */
async function runCommand(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, { cwd, timeout: 30_000 });
  return stdout.trim();
}

/** Check if a directory exists */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Result of hook installation */
export interface InstallResult {
  readonly success: boolean;
  readonly tool: HookToolName;
  readonly path: string; // Path to modified file
  readonly action: 'created' | 'updated' | 'skipped';
  readonly message: string;
}

/** Options for hook installation */
export interface InstallOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Use @kici-dev/compiler from local Verdaccio instead of the public kici package */
  useVerdaccio?: boolean;
}

/**
 * Install kici compile hook using the specified tool.
 *
 * Uses each tool's native CLI for initialization and git-hook wiring,
 * falling back to manual file creation only when the CLI is unavailable.
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
 * Install hook for Husky.
 *
 * When .husky/ doesn't exist, runs `npx husky init` to properly initialize
 * (sets core.hooksPath, creates directory structure). Falls back to manual
 * setup if the CLI is unavailable.
 *
 * Then creates or appends our command to .husky/pre-commit.
 */
async function installHuskyHook(cwd: string, command: string): Promise<InstallResult> {
  const hookDir = path.join(cwd, '.husky');
  const hookPath = path.join(hookDir, 'pre-commit');
  const template = getHookTemplate('husky');

  try {
    // Initialize husky if not already set up
    const huskyReady = await dirExists(hookDir);
    let freshInit = false;

    if (!huskyReady) {
      freshInit = await initHusky(cwd, hookDir);
    }

    // Read existing pre-commit hook
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
        // Fresh husky init creates a default pre-commit — replace it entirely
        content = template.getFullScript!(command);
        action = 'created';
      } else {
        // Existing hook with user content — append
        content += template.getCommand(command);
        action = 'updated';
      }
    } catch {
      // No pre-commit file — create from template
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

/**
 * Initialize husky using its CLI, with manual fallback.
 * Returns true if this was a fresh initialization.
 */
async function initHusky(cwd: string, hookDir: string): Promise<boolean> {
  try {
    // npx husky init: creates .husky/, sets core.hooksPath, creates default pre-commit
    await runCommand('npx --yes husky init', cwd);
    return true;
  } catch {
    // CLI not available — fall back to manual setup
    await mkdir(hookDir, { recursive: true });
    try {
      await runCommand('git config core.hooksPath .husky', cwd);
    } catch {
      /* not in a git repo or git unavailable */
    }
    return true;
  }
}

/**
 * Install hook for Lefthook.
 *
 * Edits lefthook.yml to add the kici-compile command, then runs
 * `npx lefthook install` to wire up git hooks.
 */
async function installLefthookHook(cwd: string, command: string): Promise<InstallResult> {
  // Try each possible config file location
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
      // Continue to next file
    }
  }

  if (!configPath) {
    // No lefthook config found, create default
    configPath = path.join(cwd, 'lefthook.yml');
    content = `# Lefthook configuration
# https://lefthook.dev/configuration/

pre-commit:
  parallel: true
  commands:
`;
  }

  // Check if already installed
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

  // Find the pre-commit section and add command
  if (content.includes('pre-commit:')) {
    // Extract just the pre-commit section (up to next top-level YAML key)
    // to avoid matching commands: in other sections like commit-msg:
    const preCommitIdx = content.indexOf('pre-commit:');
    const restAfterKey = content.slice(preCommitIdx + 'pre-commit:'.length);
    const nextTopLevelMatch = restAfterKey.match(/\n[a-zA-Z]/);
    const sectionEnd = nextTopLevelMatch?.index ?? restAfterKey.length;
    const preCommitSection = restAfterKey.slice(0, sectionEnd);

    if (preCommitSection.includes('commands:')) {
      // Add after commands: within the pre-commit section
      content = content.replace(/(pre-commit:[\s\S]*?commands:)/, `$1\n${hookConfig}`);
    } else {
      // Add commands section to pre-commit
      content = content.replace(/(pre-commit:.*)/, `$1\n  commands:\n${hookConfig}`);
    }
  } else {
    // Add pre-commit section
    content += `\npre-commit:\n  parallel: true\n  commands:\n${hookConfig}\n`;
  }

  try {
    await writeFile(configPath, content, 'utf-8');

    // Wire up git hooks via lefthook CLI
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
 * Install hook for pre-commit or prek.
 *
 * Both use .pre-commit-config.yaml format.
 * After editing the config, runs `pre-commit install` to wire up git hooks.
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
    // Create new config
    content = `# pre-commit configuration
# https://pre-commit.com/

repos:
`;
  }

  // Check if already installed
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

  // Add to repos section
  if (content.includes('repos:')) {
    content = content.replace(/(repos:)/, `$1\n${hookConfig}`);
  } else {
    content += `repos:\n${hookConfig}\n`;
  }

  try {
    await writeFile(configPath, content, 'utf-8');

    // Wire up git hooks via pre-commit CLI
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
 * Resolve the common git directory for hook installation.
 *
 * Git worktrees have a `commondir` file pointing to the shared git directory.
 * Hooks must be installed in the common directory (e.g., `.git/hooks/`) rather
 * than the worktree-specific directory (e.g., `.git/worktrees/<name>/hooks/`),
 * because git only looks for hooks in the common hooks directory.
 */
async function resolveCommonGitDir(gitDir: string): Promise<string> {
  try {
    const commondirPath = path.join(gitDir, 'commondir');
    const commondir = (await readFile(commondirPath, 'utf-8')).trim();
    return path.resolve(gitDir, commondir);
  } catch {
    // No commondir file — not a worktree, gitDir is already the common dir
    return gitDir;
  }
}

/**
 * Install raw git hook.
 * Creates or appends to .git/hooks/pre-commit.
 * Handles worktrees by resolving the common git directory for hooks.
 */
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
    // Ensure hooks directory exists
    await mkdir(hookDir, { recursive: true });

    let content = '';
    let action: 'created' | 'updated' = 'created';

    try {
      content = await readFile(hookPath, 'utf-8');
      action = 'updated';

      // Check if already installed
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
      // File doesn't exist, create new
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

    // Append to existing hook
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
