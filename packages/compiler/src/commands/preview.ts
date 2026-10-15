import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import type { LockFile, LockWorkflow } from '../types.js';
import { transformTriggers } from '../lockfile/generator.js';
import { discoverWorkflows, resolveKiciDir } from '../execution/index.js';
import { buildEventPayload, type PayloadOptions } from '../test-runner/payload-builder.js';
import { matchAllWorkflows, type CheckMode } from '@kici-dev/engine';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import { displayDryRun } from '../test-runner/dry-run.js';
import { loadSecretsFile, type ParsedSecrets } from '../test-runner/secrets-file.js';
import type { Workflow } from '@kici-dev/sdk';
import { flattenStepInputs } from '@kici-dev/sdk/internal';
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
  runId: string;
  status: 'accepted' | 'rejected' | 'success' | 'failed' | 'cancelled' | 'error';
  reason?: string;
  observeUrl?: string;
  durationMs?: number;
  jobs?: Array<{ name: string; status: string; durationMs?: number }>;
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

    const { workflows } = await loadWorkflows(kiciDir);
    const lockWorkflows = workflowsToLockFormat(workflows);

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

/** Workflows are always discovered (for their runtime functions); the lock file is optional. */
async function loadWorkflows(
  kiciDir: string,
): Promise<{ lockFile?: LockFile; workflows: Workflow[] }> {
  const lockFilePath = path.join(kiciDir, 'kici.lock.json');

  try {
    const lockContent = await readFile(lockFilePath, 'utf-8');
    const lockFile = JSON.parse(lockContent) as LockFile;
    logger.info(pc.gray(`Using lock file: ${lockFilePath}`));

    const result = await discoverWorkflows(kiciDir);
    return { lockFile, workflows: result.workflows.map((w) => w.workflow) };
  } catch {
    logger.info(pc.gray(`Discovering workflows from ${kiciDir}/workflows/`));
    const result = await discoverWorkflows(kiciDir);
    return { workflows: result.workflows.map((w) => w.workflow) };
  }
}

/** A lock-like shape for trigger matching. */
function workflowsToLockFormat(workflows: Workflow[]): LockWorkflow[] {
  return workflows.map((w) => ({
    name: w.name,
    contentHash: '',
    compileSchemaVersion: 0,
    triggers: transformTriggers(w.on),
    jobs: w.jobs.map((j, i) => {
      if (typeof j === 'function') {
        return { _type: 'dynamic' as const, source: { file: '', index: i } };
      }
      return {
        _type: 'static' as const,
        name: j.name,
        // runsOnAll job has no single-agent selector for the dry-run preview.
        runsOn:
          j.runsOn === undefined
            ? []
            : normalizeRunsOnToMatchers(j.runsOn as never, `job '${j.name}' runsOn`).include,
        needs:
          j.needs?.map((n) => {
            if (typeof n === 'string') return n;
            if ('name' in n) return (n as { name: string }).name;
            if ('group' in n) return `__group:${(n as { group: string }).group}`;
            return (n as { name: string }).name;
          }) ?? [],
        steps: flattenStepInputs(j.steps).map((s) => {
          if (typeof s === 'function') {
            return { name: '', hasOutputs: false };
          }
          return { name: s.name, hasOutputs: !!s.outputs };
        }),
        rules: j.rules?.map((r, ri) => ({
          _type: 'dynamic' as const,
          label: r.label,
          source: { file: '', index: ri },
        })),
        matrix: j.matrix
          ? typeof j.matrix === 'function'
            ? { _type: 'dynamic' as const, source: { file: '', jobName: j.name } }
            : {
                _type: 'static' as const,
                values: j.matrix as string[] | Record<string, string[]>,
              }
          : undefined,
        description: j.description,
      };
    }),
    rules: w.rules?.map((r, i) => ({
      _type: 'dynamic' as const,
      label: r.label,
      source: { file: '', index: i },
    })),
    description: w.description,
  }));
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
