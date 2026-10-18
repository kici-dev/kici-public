import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { detectGitRoot } from '../lockfile/generator.js';
import { workflowsToPreviewLock } from './preview-lock.js';
import { discoverWorkflows, resolveKiciDir } from '../execution/index.js';
import { buildEventPayload, type PayloadOptions } from '../test-runner/payload-builder.js';
import { matchAllWorkflows, type CheckMode } from '@kici-dev/engine';
import { displayDryRun } from '../test-runner/dry-run.js';
import { loadSecretsFile, type ParsedSecrets } from '../test-runner/secrets-file.js';
import type { Workflow } from '@kici-dev/sdk';
import { parseEventArg } from '../test-runner/event-types.js';

export interface PreviewOptions extends PayloadOptions {
  workflow?: string;
  job?: string;
  debug?: boolean;
  /** Defaults to `.kici`. */
  kiciDir?: string;
  /** Flat secret overrides: KEY=VALUE */
  secret?: string[];
  /** Context secret overrides: contextName.KEY=VALUE */
  context?: string[];
}

/** Options for `kici run remote`. */
export interface RemoteRunOptions extends PreviewOptions {
  all?: boolean;
  /** Interactive multi-select of fixtures. */
  pick?: boolean;
  parallel?: boolean;
  /** `false` (`--no-wait`): fire and forget, print runIds, don't stream. */
  wait?: boolean;
  /** Suppress output except the final result. */
  quiet?: boolean;
  json?: boolean;
  /** JUnit XML output path. */
  junit?: string;
  /**
   * `--routing-key`: accepted and ignored.
   *
   * @deprecated The orchestrator chooses the routing key; removed in v1.0.0.
   */
  routingKey?: string;
  /** `--orchestrator-url`: run on this orchestrator directly, skipping the Platform. */
  orchestratorUrl?: string;
  history?: boolean;
  /** --env KEY=VALUE flag values, uploaded as per-run secrets. */
  envFlags?: string[];
  /** Overrides config.activeOrgId. */
  org?: string;
  /** Orchestrator cluster name; overrides the per-org default. */
  orchestrator?: string;
  /** From --check / --fail-on-drift, carried on the dispatch payload. Defaults to `apply`. */
  checkMode?: CheckMode;
  /** `--target <selector>` values (repeatable), AND-combined into host narrowing. */
  targets?: string[];
  /** `--target-allow-empty`: a target that zeroes a runsOnAll job skips it instead of failing. */
  targetAllowEmpty?: boolean;
  /**
   * `--approve-all` (alias `--yes`): auto-approve every gate of the run this
   * invocation dispatched. The operator must still be clause-eligible per hold;
   * an ineligible hold blocks.
   */
  approveAll?: boolean;
  /** `--input KEY=VALUE` values (repeatable): typed workflow-dispatch inputs. */
  inputs?: string[];
}

export interface RemoteRunResult {
  fixtureId: string;
  /** The first run's id. */
  runId: string;
  /** The combined result of every run the fixture created. */
  status: 'accepted' | 'rejected' | 'success' | 'failed' | 'cancelled' | 'error';
  reason?: string;
  observeUrl?: string;
  durationMs?: number;
  jobs?: Array<{ name: string; status: string; durationMs?: number; workflowName?: string }>;
  /** One entry per run: a fixture that matches several workflows creates one run per workflow. */
  runs?: Array<{
    runId: string;
    workflowName?: string;
    status: string;
    durationMs?: number;
    jobs: Array<{ name: string; status: string; durationMs?: number; workflowName?: string }>;
  }>;
}

/**
 * `kici preview <event>`: a dry-run trigger preview that executes nothing. A
 * fixture-name argument prints a migration message.
 */
export async function previewCommand(
  event: string | undefined,
  options: PreviewOptions,
): Promise<boolean> {
  if (options.debug) {
    process.env.KICI_DEBUG = 'true';
    logger.info(pc.gray('Debug mode enabled'));
  }

  try {
    if (!event) {
      logger.info(pc.bold('\nUsage: kici preview <event>\n'));
      logger.info(pc.gray('Preview which workflows and jobs would run for a given event.\n'));
      logger.info(pc.gray('Examples:'));
      logger.info(pc.gray('  kici preview push'));
      logger.info(pc.gray('  kici preview pr:open'));
      logger.info(pc.gray('  kici preview schedule'));
      logger.info(pc.gray('  kici preview lifecycle:workflow_complete\n'));
      logger.info(
        pc.gray('For remote fixture execution, use: kici run remote [fixture] [options]'),
      );
      logger.info(pc.gray('For local workflow execution, use: kici run <event> --local\n'));
      return true;
    }

    if (!isKnownEventArg(event)) {
      logger.info(
        pc.yellow(
          `\nFixture-based testing has moved to \`kici run remote\`.\n` +
            `Run \`kici run remote ${event}\` instead.\n`,
        ),
      );
      return false;
    }

    return await previewEvent(event, options);
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (options.debug && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

/** False when the argument looks like a fixture name rather than an event. */
function isKnownEventArg(arg: string): boolean {
  try {
    parseEventArg(arg);
    return true;
  } catch {
    // A colon suggests an unrecognized event pattern; without one, a fixture name.
    return arg.includes(':');
  }
}

/** Local-only dry run: compile workflows, match triggers, display what would execute. */
export async function previewEvent(event: string, options: PreviewOptions): Promise<boolean> {
  try {
    const kiciDir = resolveKiciDir(options.kiciDir);
    logger.info(pc.gray(`KiCI directory: ${kiciDir}`));

    await loadTestSecrets(kiciDir, options.secret, options.context);

    logger.info(pc.gray(`Event: ${event}`));
    const simulatedEvent = await buildEventPayload(event, options);
    logger.info(pc.gray(`Target branch: ${simulatedEvent.targetBranch}`));
    if (simulatedEvent.sourceBranch) {
      logger.info(pc.gray(`Source branch: ${simulatedEvent.sourceBranch}`));
    }
    if (simulatedEvent.changedFiles && simulatedEvent.changedFiles.length > 0) {
      logger.info(pc.gray(`Changed files: ${simulatedEvent.changedFiles.join(', ')}`));
    }

    const workflows = await loadWorkflows(kiciDir);
    const lockWorkflows = workflowsToPreviewLock(workflows, detectGitRoot());

    const decisions = matchAllWorkflows(lockWorkflows, simulatedEvent);
    const matchedWorkflows = workflows.filter((_, i) => decisions[i].matched);

    logger.info(
      pc.gray(`Workflows: ${workflows.length} total, ${matchedWorkflows.length} matched\n`),
    );

    let filteredWorkflows = matchedWorkflows;
    if (options.workflow) {
      filteredWorkflows = matchedWorkflows.filter((w) => w.name === options.workflow);
      if (filteredWorkflows.length === 0) {
        logger.info(pc.yellow(`No workflow found matching: ${options.workflow}`));
        return false;
      }
    }

    displayDryRun(lockWorkflows, decisions, { workflow: options.workflow, job: options.job });
    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (options.debug && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

/** Discovers the workflows under `kiciDir` (sources, not the lock file). */
async function loadWorkflows(kiciDir: string): Promise<Workflow[]> {
  logger.info(pc.gray(`Discovering workflows from ${kiciDir}/workflows/`));
  const result = await discoverWorkflows(kiciDir);
  return result.workflows.map((w) => w.workflow);
}

/** `.kici/.secrets` merged with CLI overrides. */
async function loadTestSecrets(
  kiciDir: string,
  secretFlags?: string[],
  contextFlags?: string[],
): Promise<ParsedSecrets> {
  const secrets = await loadSecretsFile(kiciDir);

  if (secretFlags) {
    for (const flag of secretFlags) {
      const eqIndex = flag.indexOf('=');
      if (eqIndex === -1) continue;
      const key = flag.slice(0, eqIndex).trim();
      const value = flag.slice(eqIndex + 1).trim();
      secrets.flat[key] = value;
    }
  }

  if (contextFlags) {
    for (const flag of contextFlags) {
      const dotIndex = flag.indexOf('.');
      if (dotIndex === -1) continue;
      const contextName = flag.slice(0, dotIndex).trim();
      const rest = flag.slice(dotIndex + 1);
      const eqIndex = rest.indexOf('=');
      if (eqIndex === -1) continue;
      const key = rest.slice(0, eqIndex).trim();
      const value = rest.slice(eqIndex + 1).trim();
      if (!secrets.contexts[contextName]) {
        secrets.contexts[contextName] = {};
      }
      secrets.contexts[contextName][key] = value;
    }
  }

  return secrets;
}
