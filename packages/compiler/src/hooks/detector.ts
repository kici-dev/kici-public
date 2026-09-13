import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Supported pre-commit hook tools */
export type HookToolName = 'husky' | 'lefthook' | 'pre-commit' | 'prek' | 'git';

/** Detected hook tool with metadata */
export interface HookTool {
  readonly name: HookToolName;
  readonly configPath: string; // Path to config file/directory that was found
  readonly priority: number; // Lower = higher priority
}

/** Tool detection configuration */
interface ToolConfig {
  name: HookToolName;
  configFiles: string[]; // Files/directories to check (relative to cwd)
  priority: number;
}

const TOOL_CONFIGS: ToolConfig[] = [
  { name: 'husky', configFiles: ['.husky/'], priority: 1 },
  {
    name: 'lefthook',
    configFiles: ['lefthook.yml', '.lefthook.yml', '.config/lefthook.yml'],
    priority: 2,
  },
  { name: 'pre-commit', configFiles: ['.pre-commit-config.yaml'], priority: 3 },
  { name: 'prek', configFiles: ['prek.toml', '.prek.toml'], priority: 4 },
];

/**
 * Detect which pre-commit tools are configured in the project.
 *
 * @param cwd - Directory to check (defaults to process.cwd())
 * @returns Array of detected tools, sorted by priority (highest first)
 */
export async function detectHookTools(cwd?: string): Promise<HookTool[]> {
  const baseDir = cwd ?? process.cwd();
  const detected: HookTool[] = [];

  for (const tool of TOOL_CONFIGS) {
    for (const configFile of tool.configFiles) {
      const configPath = path.join(baseDir, configFile);
      try {
        const stats = await stat(configPath);
        // Check if it's a directory (for .husky/) or file (for others)
        if (stats.isDirectory() || stats.isFile()) {
          detected.push({
            name: tool.name,
            configPath,
            priority: tool.priority,
          });
          break; // Found this tool, move to next
        }
      } catch {
        // Config file doesn't exist, continue
      }
    }
  }

  // Sort by priority (lower number = higher priority)
  return detected.sort((a, b) => a.priority - b.priority);
}

/**
 * Resolve a .git file (used by worktrees and submodules) to the actual git directory.
 *
 * Git worktrees and submodules use a .git file containing "gitdir: <path>"
 * instead of a .git directory. The path may be absolute or relative to the
 * directory containing the .git file.
 *
 * @param gitFilePath - Path to the .git file
 * @returns Resolved absolute path to the git directory, or null if invalid
 */
async function resolveGitFile(gitFilePath: string): Promise<string | null> {
  try {
    const content = (await readFile(gitFilePath, 'utf-8')).trim();
    if (!content.startsWith('gitdir:')) {
      return null;
    }
    const gitdir = content.slice('gitdir:'.length).trim();
    if (!gitdir) {
      return null;
    }
    // Resolve relative paths against the directory containing the .git file
    const resolved = path.resolve(path.dirname(gitFilePath), gitdir);
    // Verify the resolved path exists
    const stats = await stat(resolved);
    if (stats.isDirectory()) {
      return resolved;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if running in a git repository.
 *
 * Handles both normal .git directories and .git files used by worktrees
 * and submodules. For .git files, resolves the "gitdir:" pointer to the
 * actual git directory.
 *
 * @param cwd - Directory to check (defaults to process.cwd())
 * @returns Path to git directory if found, null otherwise
 */
export async function findGitDir(cwd?: string): Promise<string | null> {
  let currentPath = path.resolve(cwd ?? process.cwd());

  while (true) {
    const gitPath = path.join(currentPath, '.git');
    try {
      const stats = await stat(gitPath);
      if (stats.isDirectory()) {
        return gitPath;
      }
      if (stats.isFile()) {
        const resolved = await resolveGitFile(gitPath);
        if (resolved) {
          return resolved;
        }
      }
    } catch {
      // .git doesn't exist, continue up
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      // Reached filesystem root
      return null;
    }
    currentPath = parentPath;
  }
}

/**
 * Get git root directory (the directory containing .git/ or .git file).
 *
 * Unlike findGitDir which returns the resolved git directory path,
 * this returns the working tree root — the directory where .git lives.
 * For worktrees and submodules, this is the directory containing the
 * .git file, not the parent of the resolved gitdir path.
 *
 * @param cwd - Directory to start from (defaults to process.cwd())
 * @returns Path to git root, or cwd if not in a git repo
 */
export async function findGitRoot(cwd?: string): Promise<string> {
  let currentPath = path.resolve(cwd ?? process.cwd());

  while (true) {
    const gitPath = path.join(currentPath, '.git');
    try {
      const stats = await stat(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return currentPath;
      }
    } catch {
      // .git doesn't exist, continue up
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return cwd ?? process.cwd();
    }
    currentPath = parentPath;
  }
}
