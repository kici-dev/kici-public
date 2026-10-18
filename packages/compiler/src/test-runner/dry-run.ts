import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { isLockParallelStep, type LockWorkflow, type LockJob } from '../types.js';
import { formatLabelMatchers, type WorkflowDecision } from '@kici-dev/engine';

interface DryRunOptions {
  workflow?: string;
  job?: string;
}

export function displayDryRun(
  workflows: readonly LockWorkflow[],
  decisions: WorkflowDecision[],
  options: DryRunOptions,
): void {
  logger.info(pc.bold('\n🔍 DRY RUN - No commands will be executed\n'));

  const matchedWorkflows = decisions.filter((d) => d.matched);

  if (matchedWorkflows.length === 0) {
    logger.info(pc.yellow('No workflows matched the event.\n'));
    displayDecisionSummary(decisions);
    return;
  }

  for (const decision of matchedWorkflows) {
    if (options.workflow && decision.workflowName !== options.workflow) {
      continue;
    }

    const workflow = workflows.find((w) => w.name === decision.workflowName)!;

    logger.info(pc.cyan(`Workflow: ${workflow.name}`));
    if (workflow.description) {
      logger.info(pc.gray(`  ${workflow.description}`));
    }

    logger.info(pc.yellow(`  Triggers:`));
    for (const trigger of workflow.triggers) {
      logger.info(`    - ${trigger._type}`);
    }

    if (decision.matchedTrigger !== undefined) {
      logger.info(pc.green(`  ✓ Matched trigger ${decision.matchedTrigger + 1}`));
    }

    const staticJobs = workflow.jobs.filter((j): j is LockJob => j._type === 'static');
    logger.info(pc.yellow(`  Jobs (${staticJobs.length}):`));

    for (const job of staticJobs) {
      if (options.job && job.name !== options.job) {
        continue;
      }

      logger.info(`    ${pc.bold(job.name)}`);
      for (const line of describeTargeting(job)) logger.info(pc.gray(`      ${line}`));

      if (job.needs.length > 0) {
        logger.info(pc.gray(`      needs: ${job.needs.join(', ')}`));
      }

      if (job.rules && job.rules.length > 0) {
        logger.info(pc.gray(`      rules: ${job.rules.map((r) => r.label).join(', ')}`));
      }

      if (job.matrix) {
        if (job.matrix._type === 'static' && job.matrix.values) {
          logger.info(pc.gray(`      matrix: ${JSON.stringify(job.matrix.values)}`));
        } else {
          logger.info(pc.gray(`      matrix: [dynamic]`));
        }
      }

      const stepCount = job.steps.reduce(
        (n, s) => n + (isLockParallelStep(s) ? s.children.length : 1),
        0,
      );
      logger.info(pc.gray(`      steps (${stepCount}):`));
      for (const step of job.steps) {
        if (isLockParallelStep(step)) {
          logger.info(pc.gray(`        - ${step.name} (parallel)`));
          for (const child of step.children) {
            logger.info(pc.gray(`          - ${child.name}`));
          }
        } else {
          logger.info(pc.gray(`        - ${step.name}`));
        }
      }
    }

    const dynamicJobs = workflow.jobs.filter((j) => j._type === 'dynamic');
    if (dynamicJobs.length > 0) {
      logger.info(pc.yellow(`  Dynamic job generators (${dynamicJobs.length}):`));
      for (const _job of dynamicJobs) {
        logger.info(pc.gray(`    - [dynamic job generator]`));
      }
    }

    logger.info('');
  }

  displayDecisionSummary(decisions);
  logger.info(pc.green('✓ Dry run complete\n'));
}

function displayDecisionSummary(decisions: WorkflowDecision[]): void {
  logger.info(pc.bold('\nDecision Summary:\n'));

  for (const decision of decisions) {
    const status = decision.matched ? pc.green('✓ matched') : pc.gray('✗ skipped');

    logger.info(`  ${decision.workflowName}: ${status}`);
    logger.info(pc.gray(`    ${decision.summary}`));

    // For a skipped workflow, the first failed check.
    if (decision.checks.length > 0 && !decision.matched) {
      const failedCheck = decision.checks.find((c) => !c.passed);
      if (failedCheck) {
        logger.info(
          pc.gray(
            `    Failed: ${failedCheck.check} - ${failedCheck.pattern} vs ${failedCheck.value}`,
          ),
        );
      }
    }
  }

  logger.info('');
}

/** The targeting lines `kici preview` prints for a job. */
function describeTargeting(job: LockJob): string[] {
  if (job.runsOnAll) {
    const groups = job.runsOnAll.include.map((g) => formatLabelMatchers(g, ' + ')).join(' | ');
    const exclude = job.runsOnAll.exclude.length
      ? ` (excluding ${formatLabelMatchers(job.runsOnAll.exclude)})`
      : '';
    return [`runs-on-all: ${groups}${exclude}`];
  }
  const lines = [`runs-on: ${job.runsOn?.length ? formatLabelMatchers(job.runsOn) : 'any agent'}`];
  if (job.excludeLabels?.length) {
    lines.push(`exclude-labels: ${formatLabelMatchers(job.excludeLabels)}`);
  }
  return lines;
}
