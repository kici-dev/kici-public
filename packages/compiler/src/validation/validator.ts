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

/** Matches the GitHub Actions limit. */
const MAX_STATIC_MATRIX_JOBS = 256;

export type ValidationResult = { valid: true } | { valid: false; errors: CompilerError[] };

/**
 * Validate workflows at compile-time.
 *
 * Checks performed:
 * 1. No duplicate workflow names
 * 2. No duplicate job names within each workflow
 * 3. Job dependencies are valid (exist, no cycles, no self-refs)
 * 4. Static matrix expansions stay under 256 job limit
 * 5. Invoke-gate jobs carry no steps and name a non-empty event
 *
 * Each error carries the most precise `file:line:column` the data allows: a
 * job-scoped error anchors to the offending job's first step location (real
 * file + real line), falling back to the workflow's source file at line 1 when
 * no step exists; a workflow-scoped error uses the workflow source file (line 1,
 * since `workflow()` captures no call-site).
 *
 * @param workflows - Source-carrying workflows from discovery
 */
export function validateConfig(workflows: WorkflowWithSource[]): ValidationResult {
  const errors: CompilerError[] = [];

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

  for (const { workflow, source } of workflows) {
    errors.push(...validateWorkflow(workflow, source.file));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

function validateWorkflow(workflow: Workflow, workflowFile: string): CompilerError[] {
  const errors: CompilerError[] = [];

  // Dynamic job functions cannot be validated at compile time.
  const staticJobs: Job[] = [];
  for (const jobOrFactory of workflow.jobs) {
    if (!isDynamicJobFn(jobOrFactory)) {
      staticJobs.push(jobOrFactory as Job);
    }
  }

  // First step location, else file:1.
  const jobLoc = (name: string): SourceLocation => {
    const j = staticJobs.find((s) => s.name === name);
    return j ? locationForJob(j, workflowFile) : { file: workflowFile, line: 1, column: 1 };
  };

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

  // Dynamic job groups become synthetic DAG nodes.
  const dynamicGroupNames = new Set<string>();
  for (const jobOrFactory of workflow.jobs) {
    if (isDynamicJobFn(jobOrFactory)) {
      const groupName = getDynamicJobGroup(jobOrFactory);
      if (groupName) {
        dynamicGroupNames.add(groupName);
      }
    }
  }

  const dagErrors = validateJobDag(staticJobs, workflow.name, jobLoc, dynamicGroupNames);
  errors.push(...dagErrors);

  for (const job of staticJobs) {
    const matrixErrors = validateStaticMatrix(job, workflow.name, workflowFile);
    errors.push(...matrixErrors);
  }

  for (const job of staticJobs) {
    errors.push(...validateInvokeJob(job, jobLoc(job.name)));
  }

  return errors;
}

/**
 * An invoke gate excludes step code and names a non-empty event. Defense in
 * depth: the SDK `job()` factory enforces both, but a generated job bypasses it.
 */
function validateInvokeJob(job: Job, location: SourceLocation): CompilerError[] {
  if (!job.invoke) return [];
  const errors: CompilerError[] = [];
  if ((job.steps?.length ?? 0) > 0) {
    errors.push(
      compilerError('E125', `job '${job.name}': 'invoke' cannot be combined with 'steps'`, {
        location,
        suggestion: 'An invoke gate never runs steps — remove `steps`/`run`, or drop `invoke`.',
      }),
    );
  }
  if (typeof job.invoke.event !== 'string' || job.invoke.event.trim().length === 0) {
    errors.push(
      compilerError('E126', `job '${job.name}': invoke.event must be a non-empty event name`, {
        location,
        suggestion:
          'Pass a kici event name to invokeSource(), e.g. invokeSource("myorg.repo-tests").',
      }),
    );
  }
  return errors;
}

/** A synthetic `__group:` node has no backing Job, so its prefix is stripped first. */
function dagNodeLocation(nodeId: string, jobLoc: (name: string) => SourceLocation): SourceLocation {
  return jobLoc(nodeId.startsWith('__group:') ? nodeId.slice('__group:'.length) : nodeId);
}

function validateJobDag(
  jobs: Job[],
  workflowName: string,
  jobLoc: (name: string) => SourceLocation,
  dynamicGroupNames?: Set<string>,
): CompilerError[] {
  const errors: CompilerError[] = [];

  const dagNodes = jobs.map((job) => ({
    id: job.name,
    needs: resolveNeeds(job.needs),
  }));

  // Group nodes have no outbound edges at compile time; real cycles through a
  // generated job are caught at runtime.
  if (dynamicGroupNames) {
    for (const groupName of dynamicGroupNames) {
      dagNodes.push({ id: `__group:${groupName}`, needs: [] });
    }
  }

  const result = validateDag(dagNodes);

  if (!result.valid) {
    switch (result.error) {
      case 'cycle':
        errors.push(
          compilerError(
            'E102',
            // Comma-join, not ' -> ': nodesInCycle is in declaration order, not
            // path order, so arrows would imply a path it does not represent.
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

/** Group references resolve to synthetic `__group:` node names. */
function resolveNeeds(needs?: Job['needs']): string[] {
  if (!needs) return [];

  return needs.map((need) => {
    if (typeof need === 'string') {
      return need;
    }
    if (isDynamicGroupRef(need)) {
      return `__group:${need.group}`;
    }
    if ('group' in need && typeof (need as { group: string }).group === 'string') {
      return `__group:${(need as { group: string }).group}`;
    }
    // NeedsEntry or Job.
    if ('name' in need) {
      return (need as { name: string }).name;
    }
    // Unreachable with the current union type.
    return String(need);
  });
}

function validateStaticMatrix(
  job: Job,
  workflowName: string,
  workflowFile: string,
): CompilerError[] {
  const errors: CompilerError[] = [];

  if (!job.matrix) return errors;

  // A dynamic matrix is evaluated at runtime.
  if (typeof job.matrix === 'function') {
    return errors;
  }

  let expansionCount = 1;

  if (isStaticArray(job.matrix)) {
    expansionCount = job.matrix.length;
  } else if (isStaticObject(job.matrix)) {
    // Cartesian product.
    expansionCount = Object.values(job.matrix).reduce(
      (acc, dimension) => acc * dimension.length,
      1,
    );
  }

  // Excludes are ignored: counting them needs the filters run, so the raw
  // expansion is the upper bound.
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
