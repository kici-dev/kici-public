import type { Workflow, Job } from '@kici-dev/sdk';
import {
  validateDag,
  isDynamicJobFn,
  isStaticArray,
  isStaticObject,
  isDynamicGroupRef,
  getDynamicJobGroup,
} from '@kici-dev/sdk';
import {
  compilerError,
  locationForJob,
  locationForWorkflow,
  type CompilerError,
  type SourceLocation,
} from '../errors/index.js';
import type { WorkflowWithSource } from '../types.js';

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
 * Each error carries the most precise `file:line:column` the data allows: a
 * job-scoped error anchors to the offending job's first step location (real
 * file + real line), falling back to the workflow's source file at line 1 when
 * no step exists; a workflow-scoped error uses the workflow source file (line 1,
 * since `workflow()` captures no call-site).
 *
 * @param workflows - Source-carrying workflows from discovery
 * @returns Validation result with errors if any
 */
export function validateConfig(workflows: WorkflowWithSource[]): ValidationResult {
  const errors: CompilerError[] = [];

  // Check for duplicate workflow names
  const workflowNames = new Set<string>();
  for (const { workflow, source } of workflows) {
    if (workflowNames.has(workflow.name)) {
      errors.push(
        compilerError('E107', `Duplicate workflow name: "${workflow.name}"`, {
          location: locationForWorkflow(source.file),
          suggestion: 'Each workflow must have a unique name',
        }),
      );
    }
    workflowNames.add(workflow.name);
  }

  // Validate each workflow
  for (const { workflow, source } of workflows) {
    errors.push(...validateWorkflow(workflow, source.file));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

/**
 * Validate a single workflow.
 */
function validateWorkflow(workflow: Workflow, workflowFile: string): CompilerError[] {
  const errors: CompilerError[] = [];

  // Separate static jobs from dynamic job functions
  const staticJobs: Job[] = [];
  for (const jobOrFactory of workflow.jobs) {
    if (!isDynamicJobFn(jobOrFactory)) {
      staticJobs.push(jobOrFactory as Job);
    }
    // Dynamic job functions can't be validated at compile-time
  }

  // Resolve a job name to its best source location (first step, else file:1).
  const jobLoc = (name: string): SourceLocation => {
    const j = staticJobs.find((s) => s.name === name);
    return j ? locationForJob(j, workflowFile) : { file: workflowFile, line: 1, column: 1 };
  };

  // Check for duplicate job names
  const jobNames = new Set<string>();
  for (const job of staticJobs) {
    if (jobNames.has(job.name)) {
      errors.push(
        compilerError('E106', `Duplicate job name "${job.name}" in workflow "${workflow.name}"`, {
          location: locationForJob(job, workflowFile),
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
  const dagErrors = validateJobDag(staticJobs, workflow.name, jobLoc, dynamicGroupNames);
  errors.push(...dagErrors);

  // Validate static matrix limits
  for (const job of staticJobs) {
    const matrixErrors = validateStaticMatrix(job, workflow.name, workflowFile);
    errors.push(...matrixErrors);
  }

  return errors;
}

/**
 * Best location for a DAG node id: strip the synthetic `__group:` prefix (which
 * has no backing Job) and resolve via the job-location lookup.
 */
function dagNodeLocation(nodeId: string, jobLoc: (name: string) => SourceLocation): SourceLocation {
  return jobLoc(nodeId.startsWith('__group:') ? nodeId.slice('__group:'.length) : nodeId);
}

/**
 * Validate job dependency DAG.
 * Includes synthetic __group: nodes for tagged dynamic job functions ( Layer 1).
 */
function validateJobDag(
  jobs: Job[],
  workflowName: string,
  jobLoc: (name: string) => SourceLocation,
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
            // Comma-join, not ' -> ': nodesInCycle is an unordered set of the jobs on
            // the cycle (declaration order), so arrows would imply a dependency path
            // that the id list does not represent.
            `Circular dependency in workflow "${workflowName}": ${result.nodesInCycle.join(', ')}`,
            {
              location: dagNodeLocation(result.nodesInCycle[0] ?? '', jobLoc),
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
              location: dagNodeLocation(result.nodeId, jobLoc),
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
              location: dagNodeLocation(result.nodeId, jobLoc),
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
function validateStaticMatrix(
  job: Job,
  workflowName: string,
  workflowFile: string,
): CompilerError[] {
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
          location: locationForJob(job, workflowFile),
          suggestion: 'Reduce matrix dimensions or use exclude patterns to limit combinations',
        },
      ),
    );
  }

  return errors;
}
