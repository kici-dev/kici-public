/**
 * Template aggregator for kici init command
 *
 * Re-exports all templates for easy consumption by the init command.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Workflow templates (real workflows for testing)
import { helloWorldWorkflow } from './workflows/hello-world.js';
import { prChecksWorkflow } from './workflows/pr-checks.js';

// Configuration templates
import { tsconfigTemplate } from './tsconfig-json.js';

// Re-export real workflows for programmatic use and type checking
export { helloWorldWorkflow } from './workflows/hello-world.js';
export { prChecksWorkflow } from './workflows/pr-checks.js';
export { generatePackageJson } from './package-json.js';
export { tsconfigTemplate } from './tsconfig-json.js';
export { agentsMdTemplate } from './agents-md.js';

/**
 * Workflow file paths for init command
 *
 * Maps workflow names to their source file paths.
 * Used by init command to read and copy workflow templates.
 */
export const workflowPaths = {
  'hello-world': path.join(__dirname, 'workflows', 'hello-world.ts'),
  'pr-checks': path.join(__dirname, 'workflows', 'pr-checks.ts'),
} as const;

/**
 * Real workflow objects map
 *
 * Maps workflow names to their compiled workflow objects.
 * Used for testing and type validation.
 */
export const workflows = {
  'hello-world': helloWorldWorkflow,
  'pr-checks': prChecksWorkflow,
} as const;

/**
 * All templates aggregated
 *
 * Provides a single object with all template types.
 */
export const templates = {
  workflowPaths,
  tsconfig: tsconfigTemplate,
} as const;
