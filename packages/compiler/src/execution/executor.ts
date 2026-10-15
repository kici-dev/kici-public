import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findKiciDir, hashKiciSourceTree } from '@kici-dev/core/kici-source-digest';
import type { Workflow } from '@kici-dev/sdk';
import { compilerError, type SourceLocation } from '../errors/index.js';
import type { WorkflowWithSource } from '../types.js';
import { ensureTsLoaderHook } from './ts-loader.js';

/**
 * Map an error stack to the first frame in `entryPoint` (ignoring the `?t=`
 * cache-buster and the `file://` scheme); falls back to line 1.
 */
function locateInEntry(stack: string | undefined, entryPoint: string): SourceLocation {
  const fallback: SourceLocation = { file: entryPoint, line: 1, column: 1 };
  if (!stack) return fallback;
  const needle = entryPoint.split('?')[0];
  for (const raw of stack.split('\n')) {
    const m = raw.match(/(.+?):(\d+):(\d+)\)?$/);
    if (m && m[1].includes(needle)) {
      return { file: entryPoint, line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
    }
  }
  return fallback;
}

/** Result of executing a config file */
export interface ExecutionResult {
  /** Workflows exported from the config with source tracking */
  workflows: WorkflowWithSource[];
  /** Absolute path to the original config file */
  configPath: string;
}

export interface DiscoveryResult {
  workflows: WorkflowWithSource[];
  /** Absolute path to `.kici/workflows/`. */
  workflowDir: string;
  /** Absolute path to `.kici/`. */
  kiciDir: string;
}

interface LoadResult {
  module: Record<string, unknown>;
  /**
   * Hash input for the lock-file `contentHash`: a digest of the whole `.kici/`
   * tree minus `.kici/node_modules/` (`hashKiciSourceTree`), exactly the files
   * the source tarball carries.
   *
   * It covers the tree, not the entry file, because the source cache keys the
   * tree: hashing the entry file alone let an edited imported helper hit the
   * cache, so the agent restored the old tarball and the OLD helper ran green.
   * Git-SHA provenance does not cover that.
   *
   * Falls back to the entry file's text outside a `.kici/` directory, and is
   * undefined when neither can be read — the generator then emits no hash and
   * no drift gate.
   */
  hashBundleSource?: string;
}

/**
 * Load a TypeScript module by dynamic import through the
 * `@kici-dev/core/ts-loader-hook` ESM hook (the same hook the agent registers in
 * its sandbox). No Rolldown bundling: host-repo imports and transitive dynamic
 * `import()`s resolve through Node's ESM loader against the workspace's
 * node_modules, so workflows importing repo-local modules (scripts/lib/*) work
 * like ones that only touch @kici-dev/sdk.
 */
async function loadModule(
  entryPoint: string,
  errorContext: { fileLabel: string; filePath: string },
): Promise<LoadResult> {
  let hashBundleSource: string | undefined;
  const kiciDir = findKiciDir(entryPoint);
  if (kiciDir) {
    const digest = await hashKiciSourceTree(kiciDir);
    if (digest) hashBundleSource = digest;
  }
  if (hashBundleSource === undefined) {
    try {
      hashBundleSource = await fs.readFile(entryPoint, 'utf-8');
    } catch {
      // Non-fatal: the generator falls back to an empty hash.
    }
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
      location: locateInEntry((err as Error).stack, errorContext.filePath),
      suggestion: `Check for TypeScript or runtime errors in your ${errorContext.fileLabel}. Make sure you invoke the workflow via the kici CLI (the bin shim registers the oxc-transform loader hook that handles TS files).`,
    });
  }
}

/**
 * Execute a TypeScript config file and extract workflow definitions.
 *
 * Imports the module through the oxc-transform TS loader hook (TypeScript
 * compiled on the fly — no bundling, no temp files) and collects workflows from
 * its default and named exports, with source tracking.
 *
 * @param configPath - Path to workflow file (relative or absolute)
 * @throws CompilerError on file not found, TypeScript errors, or missing exports
 */
export async function executeConfig(configPath: string): Promise<ExecutionResult> {
  const absolutePath = path.resolve(configPath);

  try {
    await fs.access(absolutePath);
  } catch {
    throw compilerError('E001', `Config file not found: ${absolutePath}`, {
      suggestion: 'Ensure workflow files exist in .kici/workflows/',
    });
  }

  // Validates readability.
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
 * Collect workflows from the default export (one workflow or an array) and
 * from every named export that is a Workflow.
 */
function extractWorkflows(
  module: Record<string, unknown>,
  filePath: string,
  bundleSource?: string,
): WorkflowWithSource[] {
  const workflows: WorkflowWithSource[] = [];

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

/** Workflow type guard on the SDK `_tag` discriminant. */
function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag: string })._tag === 'Workflow'
  );
}

/**
 * Resolve the absolute `.kici` directory (default `.kici`):
 * 1. the resolved path, when it has a `workflows/` subdirectory;
 * 2. else, for the default, CWD when it is itself a `.kici` with `workflows/`;
 * 3. else the resolved path, and downstream code reports the error.
 */
export function resolveKiciDir(kiciDir?: string): string {
  const raw = kiciDir ?? '.kici';
  const resolved = path.resolve(raw);

  if (existsSync(path.join(resolved, 'workflows'))) {
    return resolved;
  }

  if (raw === '.kici') {
    const cwd = process.cwd();
    if (path.basename(cwd) === '.kici' && existsSync(path.join(cwd, 'workflows'))) {
      return cwd;
    }
  }

  return resolved;
}

/**
 * Execute every top-level `*.ts` file in `.kici/workflows/` and collect its
 * workflows.
 *
 * @throws CompilerError if .kici/workflows/ doesn't exist or no workflows found
 */
export async function discoverWorkflows(kiciDir?: string): Promise<DiscoveryResult> {
  const absoluteKiciDir = resolveKiciDir(kiciDir);
  const workflowDir = path.join(absoluteKiciDir, 'workflows');

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

async function executeWorkflowFile(filePath: string): Promise<ExecutionResult> {
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
