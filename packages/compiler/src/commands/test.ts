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
import { parseEventArg } from '../test-runner/event-types.js';

/** Options for the kici test command (dry-run trigger preview) */
export interface TestOptions extends PayloadOptions {
  /** Filter to specific workflow */
  workflow?: string;
  /** Filter to specific job */
  job?: string;
  /** Enable debug output */
  debug?: boolean;
  /** Path to .kici directory (defaults to .kici) */
  kiciDir?: string;
  /** Flat secret overrides: KEY=VALUE */
  secret?: string[];
  /** Context secret overrides: contextName.KEY=VALUE */
  context?: string[];
}

/** Options for the kici run remote command */
export interface RemoteRunOptions extends TestOptions {
  /** Run all available fixtures */
  all?: boolean;
  /** Run matching fixtures concurrently */
  parallel?: boolean;
  /** Fire and forget (print runIds, don't stream) */
  wait?: boolean;
  /** Suppress output except final result */
  quiet?: boolean;
  /** Output structured JSON result */
  json?: boolean;
  /** Output JUnit XML result */
  junit?: string;
  /** Override routing key for this run */
  routingKey?: string;
  /** Show recent run history */
  history?: boolean;
  /** --env KEY=VALUE flag values, uploaded as per-run secrets. */
  envFlags?: string[];
  /** Target organization id (overrides config.activeOrgId). */
  org?: string;
  /** Target orchestrator cluster name (overrides the per-org default). */
  orchestrator?: string;
  /**
   * Run mode resolved from --check / --fail-on-drift, threaded onto the dispatch
   * payload so the orchestrator runs the agent step loop in the requested mode.
   * Defaults to `apply`.
   */
  checkMode?: CheckMode;
  /** `--target <selector>` values (repeatable), AND-combined into host narrowing. */
  targets?: string[];
  /** `--target-allow-empty`: a target that zeroes a runsOnAll job skips it instead of failing. */
  targetAllowEmpty?: boolean;
  /**
   * `--approve-all` (alias `--yes`): auto-approve every approval gate this run
   * holds on (run-scoped only — the run id this invocation dispatched). The
   * operator must still be clause-eligible per hold; an ineligible hold blocks.
   */
  approveAll?: boolean;
}

/** Result of a single remote fixture run */
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
 * Main test command entry point.
 *
 * `kici test <event>` is now dry-run trigger preview only.
 * If the argument looks like a fixture name (not a known event type), prints a migration message.
 */
export async function testCommand(
  event: string | undefined,
  options: TestOptions,
): Promise<boolean> {
  if (options.debug) {
    process.env.KICI_DEBUG = 'true';
    logger.info(pc.gray('Debug mode enabled'));
  }

  try {
    // No event provided
    if (!event) {
      logger.info(pc.bold('\nUsage: kici test <event>\n'));
      logger.info(pc.gray('Preview which workflows and jobs would run for a given event.\n'));
      logger.info(pc.gray('Examples:'));
      logger.info(pc.gray('  kici test push'));
      logger.info(pc.gray('  kici test pr:open'));
      logger.info(pc.gray('  kici test schedule'));
      logger.info(pc.gray('  kici test lifecycle:workflow_complete\n'));
      logger.info(
        pc.gray('For remote fixture execution, use: kici run remote [fixture] [options]'),
      );
      logger.info(pc.gray('For local workflow execution, use: kici run local <event> [options]\n'));
      return true;
    }

    // Check if the event looks like a fixture name rather than a known event type.
    // If parseEventArg throws and the arg doesn't contain a colon, it's probably a fixture name.
    if (!isKnownEventArg(event)) {
      logger.info(
        pc.yellow(
          `\nFixture-based testing has moved to \`kici run remote\`.\n` +
            `Run \`kici run remote ${event}\` instead.\n`,
        ),
      );
      return false;
    }

    // Run dry-run trigger preview
    return await testDryRun(event, options);
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (options.debug && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

/**
 * Check if the argument is a known event type.
 * Returns true if parseEventArg succeeds, false if it looks like a fixture name.
 */
function isKnownEventArg(arg: string): boolean {
  try {
    parseEventArg(arg);
    return true;
  } catch {
    // parseEventArg throws for unknown events.
    // If the arg contains a colon, it might be an event pattern we don't recognize yet.
    // Without a colon, it's likely a fixture name.
    return arg.includes(':');
  }
}

/**
 * Local-only dry-run mode: compile workflows, match triggers, display what would execute.
 */
export async function testDryRun(event: string, options: TestOptions): Promise<boolean> {
  try {
    // Resolve .kici directory
    const kiciDir = resolveKiciDir(options.kiciDir);
    logger.info(pc.gray(`KiCI directory: ${kiciDir}`));

    // Load secrets from .kici/.secrets file + CLI overrides
    await loadTestSecrets(kiciDir, options.secret, options.context);

    // Build event payload
    logger.info(pc.gray(`Event: ${event}`));
    const simulatedEvent = await buildEventPayload(event, options);
    logger.info(pc.gray(`Target branch: ${simulatedEvent.targetBranch}`));
    if (simulatedEvent.sourceBranch) {
      logger.info(pc.gray(`Source branch: ${simulatedEvent.sourceBranch}`));
    }
    if (simulatedEvent.changedFiles && simulatedEvent.changedFiles.length > 0) {
      logger.info(pc.gray(`Changed files: ${simulatedEvent.changedFiles.join(', ')}`));
    }

    // Load workflows
    const { workflows } = await loadWorkflows(kiciDir);
    const lockWorkflows = workflowsToLockFormat(workflows);

    // Match triggers
    const decisions = matchAllWorkflows(lockWorkflows, simulatedEvent);
    const matchedWorkflows = workflows.filter((_, i) => decisions[i].matched);

    logger.info(
      pc.gray(`Workflows: ${workflows.length} total, ${matchedWorkflows.length} matched\n`),
    );

    // Apply filters
    let filteredWorkflows = matchedWorkflows;
    if (options.workflow) {
      filteredWorkflows = matchedWorkflows.filter((w) => w.name === options.workflow);
      if (filteredWorkflows.length === 0) {
        logger.info(pc.yellow(`No workflow found matching: ${options.workflow}`));
        return false;
      }
    }

    // Display dry-run output
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

// --- Internal helpers ---

/**
 * Load lock file if exists, otherwise discover workflows.
 */
async function loadWorkflows(
  kiciDir: string,
): Promise<{ lockFile?: LockFile; workflows: Workflow[] }> {
  const lockFilePath = path.join(kiciDir, 'kici.lock.json');

  // Try to load existing lock file
  try {
    const lockContent = await readFile(lockFilePath, 'utf-8');
    const lockFile = JSON.parse(lockContent) as LockFile;
    logger.info(pc.gray(`Using lock file: ${lockFilePath}`));

    // Also need to discover workflows to get runtime functions
    const result = await discoverWorkflows(kiciDir);
    return { lockFile, workflows: result.workflows.map((w) => w.workflow) };
  } catch {
    // No lock file, discover workflows
    logger.info(pc.gray(`Discovering workflows from ${kiciDir}/workflows/`));
    const result = await discoverWorkflows(kiciDir);
    return { workflows: result.workflows.map((w) => w.workflow) };
  }
}

/**
 * Convert SDK Workflow to lock-file-like structure for trigger matching.
 */
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
        steps: j.steps.map((s) => {
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

/**
 * Load test secrets from .kici/.secrets file and merge CLI overrides.
 */
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
