import type { Workflow, Job } from '@kici-dev/sdk';
import {
  validateDag,
  isDynamicJobFn,
  isStaticArray,
  isStaticObject,
  isDynamicGroupRef,
  getDynamicJobGroup,
} from '@kici-dev/sdk';
import { compilerError, type CompilerError } from '../errors/index.js';

/** Maximum jobs from static matrix expansion (GitHub Actions limit) */
const MAX_STATIC_MATRIX_JOBS = 256;

/**
 * Validation result - either success or list of errors.
 */
export type ValidationResult = { valid: true } | { valid: false; errors: CompilerError[] };

/**
 * Validate workflows at compile-time.
 *
 * Checks performed:
 * 1. No duplicate workflow names
 * 2. No duplicate job names within each workflow
 * 3. Job dependencies are valid (exist, no cycles, no self-refs)
 * 4. Static matrix expansions stay under 256 job limit
 *
 * @param workflows - Array of workflows from config
 * @param configPath - Path for error location reporting
 * @returns Validation result with errors if any
 */
export function validateConfig(workflows: Workflow[], configPath: string): ValidationResult {
  const errors: CompilerError[] = [];

  // Check for duplicate workflow names
  const workflowNames = new Set<string>();
  for (const workflow of workflows) {
    if (workflowNames.has(workflow.name)) {
      errors.push(
        compilerError('E107', `Duplicate workflow name: "${workflow.name}"`, {
          location: { file: configPath, line: 1, column: 1 },
          suggestion: 'Each workflow must have a unique name',
        }),
      );
    }
    workflowNames.add(workflow.name);
  }

  // Validate each workflow
  for (const workflow of workflows) {
    const workflowErrors = validateWorkflow(workflow, configPath);
    errors.push(...workflowErrors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

/**
 * Validate a single workflow.
 */
function validateWorkflow(workflow: Workflow, configPath: string): CompilerError[] {
  const errors: CompilerError[] = [];

  // Separate static jobs from dynamic job functions
  const staticJobs: Job[] = [];
  for (const jobOrFactory of workflow.jobs) {
    if (!isDynamicJobFn(jobOrFactory)) {
      staticJobs.push(jobOrFactory as Job);
    }
    // Dynamic job functions can't be validated at compile-time
  }

  // Check for duplicate job names
  const jobNames = new Set<string>();
  for (const job of staticJobs) {
    if (jobNames.has(job.name)) {
      errors.push(
        compilerError('E106', `Duplicate job name "${job.name}" in workflow "${workflow.name}"`, {
          location: { file: configPath, line: 1, column: 1 },
          suggestion: 'Each job in a workflow must have a unique name',
        }),
      );
    }
    jobNames.add(job.name);
  }

  // Collect dynamic job group names for synthetic DAG nodes ( Layer 1)
  const dynamicGroupNames = new Set<string>();
  for (const jobOrFactory of workflow.jobs) {
    if (isDynamicJobFn(jobOrFactory)) {
      const groupName = getDynamicJobGroup(jobOrFactory);
      if (groupName) {
        dynamicGroupNames.add(groupName);
      }
    }
  }

  // Validate DAG dependencies (with synthetic group nodes)
  const dagErrors = validateJobDag(staticJobs, workflow.name, configPath, dynamicGroupNames);
  errors.push(...dagErrors);

  // Validate static matrix limits
  for (const job of staticJobs) {
    const matrixErrors = validateStaticMatrix(job, workflow.name, configPath);
    errors.push(...matrixErrors);
  }

  return errors;
}

/**
 * Validate job dependency DAG.
 * Includes synthetic __group: nodes for tagged dynamic job functions ( Layer 1).
 */
function validateJobDag(
  jobs: Job[],
  workflowName: string,
  configPath: string,
  dynamicGroupNames?: Set<string>,
): CompilerError[] {
  const errors: CompilerError[] = [];

  // Build DAG nodes from static jobs
  const dagNodes = jobs.map((job) => ({
    id: job.name,
    needs: resolveNeeds(job.needs),
  }));

  // Add synthetic nodes for dynamic groups ( Layer 1)
  // These have no outbound edges at compile time (Layer 2 catches actual cycles)
  if (dynamicGroupNames) {
    for (const groupName of dynamicGroupNames) {
      dagNodes.push({ id: `__group:${groupName}`, needs: [] });
    }
  }

  // Use SDK's validateDag function
  const result = validateDag(dagNodes);

  if (!result.valid) {
    switch (result.error) {
      case 'cycle':
        errors.push(
          compilerError(
            'E102',
            `Circular dependency in workflow "${workflowName}": ${result.nodesInCycle.join(' -> ')}`,
            {
              location: { file: configPath, line: 1, column: 1 },
              suggestion: 'Break the cycle by removing one of the dependencies',
            },
          ),
        );
        break;

      case 'self-reference':
        errors.push(
          compilerError(
            'E103',
            `Job "${result.nodeId}" in workflow "${workflowName}" depends on itself`,
            {
              location: { file: configPath, line: 1, column: 1 },
              suggestion: 'Remove the self-dependency',
            },
          ),
        );
        break;

      case 'missing-dependency':
        errors.push(
          compilerError(
            'E101',
            `Job "${result.nodeId}" in workflow "${workflowName}" depends on non-existent job "${result.missingDep}"`,
            {
              location: { file: configPath, line: 1, column: 1 },
              suggestion: `Create a job named "${result.missingDep}" or fix the dependency name`,
            },
          ),
        );
        break;
    }
  }

  return errors;
}

/**
 * Resolve needs array to job names (handling Job objects, strings, DynamicGroupRef, and object forms).
 * DynamicGroupRef and { group } forms resolve to synthetic __group: node names.
 */
function resolveNeeds(needs?: Job['needs']): string[] {
  if (!needs) return [];

  return needs.map((need) => {
    if (typeof need === 'string') {
      return need;
    }
    // DynamicGroupRef (Symbol-tagged)
    if (isDynamicGroupRef(need)) {
      return `__group:${need.group}`;
    }
    // Object form with 'group' property (NeedsGroupEntry)
    if ('group' in need && typeof (need as { group: string }).group === 'string') {
      return `__group:${(need as { group: string }).group}`;
    }
    // Object form with 'name' property (NeedsEntry or Job)
    if ('name' in need) {
      return (need as { name: string }).name;
    }
    // Unreachable with current union type, but defensive fallback
    return String(need);
  });
}

/**
 * Validate static matrix doesn't exceed job limit.
 */
function validateStaticMatrix(job: Job, workflowName: string, configPath: string): CompilerError[] {
  const errors: CompilerError[] = [];

  if (!job.matrix) return errors;

  // Only validate static matrices at compile-time
  // Dynamic matrices are evaluated at runtime
  if (typeof job.matrix === 'function') {
    return errors;
  }

  let expansionCount = 1;

  if (isStaticArray(job.matrix)) {
    // Single-dimension: count is array length
    expansionCount = job.matrix.length;
  } else if (isStaticObject(job.matrix)) {
    // Multi-dimension: count is cartesian product
    expansionCount = Object.values(job.matrix).reduce(
      (acc, dimension) => acc * dimension.length,
      1,
    );
  }

  // Apply exclude filter (reduces count)
  // We can't precisely calculate without running the filters,
  // so we use the raw expansion count as upper bound

  // Apply include additions
  if (job.include) {
    expansionCount += job.include.length;
  }

  if (expansionCount > MAX_STATIC_MATRIX_JOBS) {
    errors.push(
      compilerError(
        'E104',
        `Static matrix for job "${job.name}" in workflow "${workflowName}" would generate ${expansionCount} jobs (max: ${MAX_STATIC_MATRIX_JOBS})`,
        {
          location: { file: configPath, line: 1, column: 1 },
          suggestion: 'Reduce matrix dimensions or use exclude patterns to limit combinations',
        },
      ),
    );
  }

  return errors;
}
