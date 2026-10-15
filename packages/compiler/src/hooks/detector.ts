import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type HookToolName = 'husky' | 'lefthook' | 'pre-commit' | 'prek' | 'git';

export interface HookTool {
  readonly name: HookToolName;
  readonly configPath: string;
  readonly priority: number; // Lower = higher priority
}

interface ToolConfig {
  name: HookToolName;
  configFiles: string[]; // Relative to cwd
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

/** Configured pre-commit tools in `cwd`, highest priority first. */
export async function detectHookTools(cwd?: string): Promise<HookTool[]> {
  const baseDir = cwd ?? process.cwd();
  const detected: HookTool[] = [];

  for (const tool of TOOL_CONFIGS) {
    for (const configFile of tool.configFiles) {
      const configPath = path.join(baseDir, configFile);
      try {
        const stats = await stat(configPath);
        if (stats.isDirectory() || stats.isFile()) {
          detected.push({
            name: tool.name,
            configPath,
            priority: tool.priority,
          });
          break;
        }
      } catch {
        // Absent.
      }
    }
  }

  return detected.sort((a, b) => a.priority - b.priority);
}

/**
 * Resolve a worktree / submodule `.git` file (`gitdir: <path>`, absolute or
 * relative to the file's directory) to the git directory, or null if invalid.
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
    const resolved = path.resolve(path.dirname(gitFilePath), gitdir);
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
 * The git directory of the repository containing `cwd`, walking upward, or
 * null. A worktree / submodule `.git` file resolves through its `gitdir:`.
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
      // No .git here; continue up.
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

/**
 * The working tree root: the directory holding `.git` (for a worktree or
 * submodule, the `.git` file's directory, not the resolved gitdir's parent).
 * Falls back to `cwd` outside a git repo.
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
      // No .git here; continue up.
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return cwd ?? process.cwd();
    }
    currentPath = parentPath;
  }
}
