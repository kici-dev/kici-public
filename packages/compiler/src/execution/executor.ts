import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Workflow } from '@kici-dev/sdk';
import { compilerError } from '../errors/index.js';
import type { WorkflowWithSource } from '../types.js';
import { ensureTsLoaderHook } from './ts-loader.js';

/** Result of executing a config file */
export interface ExecutionResult {
  /** Workflows exported from the config with source tracking */
  workflows: WorkflowWithSource[];
  /** Absolute path to the original config file */
  configPath: string;
}

/** Result of discovering workflows from .kici/workflows/ directory */
export interface DiscoveryResult {
  /** All workflows discovered from .kici/workflows/ with source tracking */
  workflows: WorkflowWithSource[];
  /** Absolute path to .kici/workflows/ directory */
  workflowDir: string;
  /** Absolute path to .kici/ directory */
  kiciDir: string;
}

// ---------------------------------------------------------------------------
// Shared module loader (private)
// ---------------------------------------------------------------------------

interface LoadResult {
  module: Record<string, unknown>;
  /**
   * Raw source file text. Used for content hashing in the lock file. For
   * workflows that import host-repo code (e.g. our staging deploy workflow
   * importing packages/ci/src/deploy-stg/*), this is intentionally only the
   * entry file, not the transitive closure — a Merkle-style deep hash
   * would be more robust but is not required: every lock file entry is
   * tied to a git SHA, so drift in imported files is already covered by
   * commit provenance.
   */
  hashBundleSource?: string;
}

/**
 * Load a TypeScript workflow/config module by direct dynamic import.
 *
 * Relies on the `@kici-dev/core/ts-loader-hook` ESM loader hook, registered
 * lazily via `ensureTsLoaderHook()` just before the dynamic import (the same
 * hook the agent registers in its sandbox process). No Rolldown bundling:
 * host-repo imports and
 * transitive deps with dynamic import() resolve via Node's normal ESM loader
 * against the workspace's node_modules — the same module graph any other
 * `pnpm exec tsx` invocation would see. This keeps ops-style workflows (which
 * import repo-local modules like scripts/lib/*) working the same as minimal
 * workflows that only touch @kici-dev/sdk.
 */
async function loadModule(
  entryPoint: string,
  errorContext: { fileLabel: string; filePath: string },
): Promise<LoadResult> {
  let hashBundleSource: string | undefined;
  try {
    hashBundleSource = await fs.readFile(entryPoint, 'utf-8');
  } catch {
    // Non-fatal for hashing — generator will fall back to empty hash
  }

  try {
    ensureTsLoaderHook();
    const moduleUrl = pathToFileURL(entryPoint).href;
    const cacheBuster = `?t=${Date.now()}`;
    const mod = (await import(moduleUrl + cacheBuster)) as Record<string, unknown>;
    return { module: mod, hashBundleSource };
  } catch (err) {
    const message = (err as Error).message ?? 'Failed to load module';
    throw compilerError('E003', `Failed to load ${errorContext.fileLabel} module: ${message}`, {
      location: { file: errorContext.filePath, line: 1, column: 1 },
      suggestion: `Check for TypeScript or runtime errors in your ${errorContext.fileLabel}. Make sure you invoke the workflow via the kici CLI (the bin shim registers the oxc-transform loader hook that handles TS files).`,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a TypeScript config file and extract workflow definitions.
 *
 * Process:
 * 1. Read TypeScript source from disk
 * 2. Transform to ESM JavaScript via rolldown (in-memory)
 * 3. Write temp file for Node.js dynamic import (required by ESM spec)
 * 4. Dynamic import the compiled module
 * 5. Extract and return workflow definitions
 * 6. Clean up temp file
 *
 * @param configPath - Path to workflow file (relative or absolute)
 * @returns Workflows exported from the config
 * @throws CompilerError on file not found, TypeScript errors, or missing exports
 */
export async function executeConfig(configPath: string): Promise<ExecutionResult> {
  const absolutePath = path.resolve(configPath);

  // Check file exists
  try {
    await fs.access(absolutePath);
  } catch {
    throw compilerError('E001', `Config file not found: ${absolutePath}`, {
      suggestion: 'Ensure workflow files exist in .kici/workflows/',
    });
  }

  // Read TypeScript source (validates readability)
  try {
    await fs.readFile(absolutePath, 'utf-8');
  } catch {
    throw compilerError('E001', `Failed to read config file: ${absolutePath}`, {
      suggestion: 'Check file permissions',
    });
  }

  const { module, hashBundleSource } = await loadModule(absolutePath, {
    fileLabel: 'config file',
    filePath: absolutePath,
  });

  const workflows = extractWorkflows(module, absolutePath, hashBundleSource);

  return { workflows, configPath: absolutePath };
}

/**
 * Extract workflow definitions from a module's exports with source tracking.
 *
 * Supports:
 * - Default export: single workflow or array of workflows
 * - Named exports: any export that is a Workflow object
 *
 * @param module - The imported module
 * @param filePath - Absolute path to the source file
 * @returns Array of WorkflowWithSource objects
 */
function extractWorkflows(
  module: Record<string, unknown>,
  filePath: string,
  bundleSource?: string,
): WorkflowWithSource[] {
  const workflows: WorkflowWithSource[] = [];

  // Check default export first
  if (module.default) {
    const defaultExport = module.default;

    if (isWorkflow(defaultExport)) {
      workflows.push({
        workflow: defaultExport,
        source: {
          file: filePath,
          exportName: 'default',
        },
        bundleSource,
      });
    } else if (Array.isArray(defaultExport)) {
      defaultExport.forEach((item, index) => {
        if (isWorkflow(item)) {
          workflows.push({
            workflow: item,
            source: {
              file: filePath,
              exportName: 'default',
              arrayIndex: index,
            },
            bundleSource,
          });
        }
      });
    }
  }

  // Check named exports
  for (const [key, value] of Object.entries(module)) {
    if (key === 'default') continue;

    if (isWorkflow(value)) {
      workflows.push({
        workflow: value,
        source: {
          file: filePath,
          exportName: key,
        },
        bundleSource,
      });
    }
  }

  if (workflows.length === 0) {
    throw compilerError('E004', 'Config does not export any workflows', {
      location: { file: filePath, line: 1, column: 1 },
      suggestion:
        'Export a workflow using: export default workflow("name", { ... }) or export const myWorkflow = workflow(...)',
    });
  }

  return workflows;
}

/**
 * Type guard to check if a value is a Workflow object.
 * Uses _tag discriminant from SDK.
 */
function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag: string })._tag === 'Workflow'
  );
}

/**
 * Resolve the .kici directory path, handling the case where the user
 * is already inside the .kici directory (or a subdirectory of it).
 *
 * Resolution order:
 * 1. If the resolved path has a workflows/ subdirectory, use it directly
 * 2. If CWD itself is named .kici and has workflows/, use CWD
 * 3. Fall through to the original resolved path (downstream code will error)
 *
 * @param kiciDir - Path to .kici directory (defaults to '.kici')
 * @returns Absolute path to the .kici directory
 */
export function resolveKiciDir(kiciDir?: string): string {
  const raw = kiciDir ?? '.kici';
  const resolved = path.resolve(raw);

  // Happy path: resolved dir has workflows/ -> we're at repo root
  if (existsSync(path.join(resolved, 'workflows'))) {
    return resolved;
  }

  // If using default and CWD is itself the .kici dir
  if (raw === '.kici') {
    const cwd = process.cwd();
    if (path.basename(cwd) === '.kici' && existsSync(path.join(cwd, 'workflows'))) {
      return cwd;
    }
  }

  // Fall through -- downstream code will produce a proper error
  return resolved;
}

/**
 * Discover and execute all workflow files from .kici/workflows/ directory.
 *
 * Process:
 * 1. Locate .kici/workflows/ directory (defaults to .kici relative to cwd)
 * 2. Find all *.ts files in the directory
 * 3. Execute each file to extract workflow definitions
 * 4. Collect and return all workflows
 *
 * @param kiciDir - Path to .kici directory (defaults to '.kici' relative to cwd)
 * @returns Discovery result with all workflows and directory paths
 * @throws CompilerError if .kici/workflows/ doesn't exist or no workflows found
 */
export async function discoverWorkflows(kiciDir?: string): Promise<DiscoveryResult> {
  const absoluteKiciDir = resolveKiciDir(kiciDir);
  const workflowDir = path.join(absoluteKiciDir, 'workflows');

  // Check if .kici/workflows/ exists
  try {
    const stat = await fs.stat(workflowDir);
    if (!stat.isDirectory()) {
      throw compilerError('E001', `.kici/workflows/ is not a directory: ${workflowDir}`, {
        suggestion: 'Run "kici init" to create the .kici/workflows/ directory',
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw compilerError('E001', `.kici/workflows/ directory not found: ${workflowDir}`, {
        suggestion: 'Run "kici init" to create the .kici/workflows/ directory',
      });
    }
    throw err;
  }

  // Find all *.ts files in .kici/workflows/
  let files: string[];
  try {
    const entries = await fs.readdir(workflowDir, { withFileTypes: true });
    files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(workflowDir, entry.name));
  } catch {
    throw compilerError('E001', `Failed to read .kici/workflows/ directory: ${workflowDir}`, {
      suggestion: 'Check directory permissions',
    });
  }

  if (files.length === 0) {
    throw compilerError('E001', 'No workflow files found in .kici/workflows/', {
      suggestion: 'Add *.ts workflow files to .kici/workflows/ or run "kici init"',
    });
  }

  // Execute each workflow file and collect workflows with source tracking
  const allWorkflows: WorkflowWithSource[] = [];
  for (const file of files) {
    const result = await executeWorkflowFile(file);
    allWorkflows.push(...result.workflows);
  }

  if (allWorkflows.length === 0) {
    throw compilerError('E004', 'No workflows exported from .kici/workflows/ files', {
      suggestion:
        'Ensure your workflow files export workflows using: export const myWorkflow = workflow(...)',
    });
  }

  return {
    workflows: allWorkflows,
    workflowDir,
    kiciDir: absoluteKiciDir,
  };
}

/**
 * Execute a single workflow file and extract workflow definitions.
 * Similar to executeConfig but for individual workflow files.
 *
 * @param filePath - Absolute path to workflow file
 * @returns Execution result with workflows from this file
 */
async function executeWorkflowFile(filePath: string): Promise<ExecutionResult> {
  // Verify the file exists before proceeding
  try {
    await fs.access(filePath);
  } catch {
    throw compilerError('E001', `Failed to read workflow file: ${filePath}`, {
      suggestion: 'Check file permissions',
    });
  }

  const { module, hashBundleSource } = await loadModule(filePath, {
    fileLabel: 'workflow file',
    filePath,
  });

  const workflows = extractWorkflows(module, filePath, hashBundleSource);

  return { workflows, configPath: filePath };
}
