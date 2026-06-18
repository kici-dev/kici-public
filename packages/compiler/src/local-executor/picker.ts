/**
 * Interactive workflow picker for `kici run local --pick`.
 *
 * Lists every workflow with a summary of its triggers, lets the user pick one
 * (and a specific trigger when there are multiple), and returns the derived
 * event arg plus workflow name. The caller feeds these back into the standard
 * executeLocal pipeline so the run remains consistent with normal trigger
 * matching.
 */

import pc from 'picocolors';
import { select } from '@inquirer/prompts';
import { logger } from '@kici-dev/core';
import type { Workflow } from '@kici-dev/sdk';
import { transformTriggers } from '../lockfile/generator.js';
import { triggerToEventArg, triggerSummary, parseEventArg } from '../test-runner/event-types.js';
import type { LockTrigger } from '../types.js';

export class PickerCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickerCancelledError';
  }
}

export interface PickerOptions {
  /**
   * Optional event-arg filter. When set, restrict the workflow list to those
   * with at least one trigger whose derived event arg shares the same family
   * (e.g. `filterEvent: 'pr'` keeps any workflow with a `pr:*` trigger).
   */
  filterEvent?: string;
}

export interface PickerResult {
  event: string;
  workflow: string;
}

interface WorkflowEntry {
  name: string;
  triggers: readonly LockTrigger[];
}

function workflowEntries(workflows: Workflow[]): WorkflowEntry[] {
  return workflows.map((w) => ({
    name: w.name,
    triggers: transformTriggers(w.on),
  }));
}

function eventFamily(arg: string): string {
  return arg.toLowerCase().split(':')[0] ?? '';
}

function filterFamily(arg: string): string {
  try {
    const parsed = parseEventArg(arg);
    if (parsed.type === 'pull_request') return 'pr';
    return parsed.type;
  } catch {
    return eventFamily(arg);
  }
}

function triggerFamilies(trigger: LockTrigger): string[] {
  const eventArg = triggerToEventArg(trigger);
  const head = eventFamily(eventArg);
  // generic_webhook derives to `webhook:<source>` — surface both aliases.
  if (trigger._type === 'generic_webhook') return ['webhook', 'generic_webhook'];
  // workflow_complete / job_complete live under the lifecycle family too.
  if (trigger._type === 'workflow_complete') return [head, 'lifecycle'];
  if (trigger._type === 'job_complete') return [head, 'lifecycle'];
  return [head];
}

function isStdinTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

function printWorkflowList(entries: WorkflowEntry[]): void {
  logger.info(pc.bold('Available workflows:'));
  for (const entry of entries) {
    const summaries = entry.triggers.map(triggerSummary).join(', ') || '(no triggers)';
    logger.info(`  ${pc.cyan(entry.name)} — ${summaries}`);
  }
}

/**
 * Run the interactive picker.
 *
 * @throws PickerCancelledError when stdin is not a TTY, when no eligible
 *   workflows exist, or when the user aborts one of the prompts.
 */
export async function runPicker(
  workflows: Workflow[],
  opts: PickerOptions = {},
): Promise<PickerResult> {
  let entries = workflowEntries(workflows).filter((e) => e.triggers.length > 0);

  if (opts.filterEvent) {
    const family = filterFamily(opts.filterEvent);
    entries = entries.filter((e) => e.triggers.some((t) => triggerFamilies(t).includes(family)));
  }

  if (entries.length === 0) {
    throw new PickerCancelledError(
      opts.filterEvent
        ? `No workflows with triggers matching "${opts.filterEvent}". Remove the event arg or pass a different one.`
        : 'No workflows with triggers available to pick.',
    );
  }

  if (!isStdinTty()) {
    printWorkflowList(entries);
    throw new PickerCancelledError(
      'Non-interactive environment: --pick requires a TTY. Pass --workflow <name> plus an event arg instead.',
    );
  }

  let chosenWorkflow: WorkflowEntry;
  try {
    const name = await select<string>({
      message: 'Select a workflow to run',
      choices: entries.map((e) => ({
        name: `${e.name} — ${e.triggers.map(triggerSummary).join(', ')}`,
        value: e.name,
      })),
    });
    chosenWorkflow = entries.find((e) => e.name === name)!;
  } catch (err) {
    throw new PickerCancelledError(
      `Picker cancelled: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let trigger: LockTrigger;
  if (chosenWorkflow.triggers.length === 1) {
    trigger = chosenWorkflow.triggers[0]!;
  } else {
    try {
      trigger = await select<LockTrigger>({
        message: `Select a trigger for "${chosenWorkflow.name}"`,
        choices: chosenWorkflow.triggers.map((t) => ({
          name: triggerSummary(t),
          value: t,
        })),
      });
    } catch (err) {
      throw new PickerCancelledError(
        `Picker cancelled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    event: triggerToEventArg(trigger),
    workflow: chosenWorkflow.name,
  };
}
