/** `kici endpoints`: the project's webhook entrypoints from the lock file, grouped by type. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveKiciDir } from '../execution/index.js';
import { loadGlobalConfig } from '../remote/config.js';
import type { LockFile, LockWorkflow, LockTrigger } from '../types.js';

export interface EndpointsOptions {
  /** Defaults to .kici */
  kiciDir?: string;
}

interface TriggerGroup {
  gitProvider: Array<{ workflowName: string; provider: string }>;
  genericWebhook: Array<{ workflowName: string; source: string; path?: string }>;
  schedule: Array<{ workflowName: string; cron: string; timezone: string; description?: string }>;
  lifecycle: Array<{ workflowName: string; events: readonly string[]; description?: string }>;
  kiciEvent: Array<{ workflowName: string; eventName: string }>;
}

export async function endpointsCommand(options: EndpointsOptions): Promise<boolean> {
  try {
    const kiciDir = resolveKiciDir(options.kiciDir);
    const lockFilePath = path.join(kiciDir, 'kici.lock.json');

    let lockFile: LockFile;
    try {
      const content = await readFile(lockFilePath, 'utf-8');
      lockFile = JSON.parse(content) as LockFile;
    } catch {
      logger.error(
        pc.red('No lock file found. Run `kici compile` to generate kici.lock.json first.'),
      );
      return false;
    }

    // `activeOrgId` is set by `kici org use`.
    const config = await loadGlobalConfig();
    const orgId = config.activeOrgId ?? '{orgId}';

    const groups = groupTriggers(lockFile.workflows);

    displayEndpoints(groups, orgId);

    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`Error: ${message}`));
    return false;
  }
}

export function groupTriggers(workflows: readonly LockWorkflow[]): TriggerGroup {
  const groups: TriggerGroup = {
    gitProvider: [],
    genericWebhook: [],
    schedule: [],
    lifecycle: [],
    kiciEvent: [],
  };

  for (const workflow of workflows) {
    for (const trigger of workflow.triggers) {
      categorizeTrigger(workflow.name, trigger, groups);
    }
  }

  return groups;
}

function categorizeTrigger(workflowName: string, trigger: LockTrigger, groups: TriggerGroup): void {
  switch (trigger._type) {
    case 'pr':
    case 'push':
    case 'tag':
    case 'comment':
    case 'review':
    case 'review_comment':
    case 'release':
    case 'dispatch':
    case 'create':
    case 'delete':
    case 'status':
    case 'workflow_run':
    case 'fork':
    case 'star':
    case 'watch':
    case 'webhook':
      if (!groups.gitProvider.some((g) => g.workflowName === workflowName)) {
        groups.gitProvider.push({ workflowName, provider: 'GitHub' });
      }
      break;

    case 'generic_webhook':
      groups.genericWebhook.push({
        workflowName,
        source: trigger.source,
        path: trigger.path,
      });
      break;

    case 'schedule':
      groups.schedule.push({
        workflowName,
        cron: trigger.cronExpression,
        timezone: trigger.timezone,
        description: trigger.description,
      });
      break;

    case 'lifecycle':
      groups.lifecycle.push({
        workflowName,
        events: trigger.events,
        description: trigger.description,
      });
      break;

    case 'kici_event':
      groups.kiciEvent.push({
        workflowName,
        eventName: trigger.eventName,
      });
      break;

    case 'workflow_complete':
      groups.kiciEvent.push({
        workflowName,
        eventName: `workflow_complete${trigger.name ? `:${trigger.name}` : ''}`,
      });
      break;

    case 'workflows_failed_batch':
      groups.kiciEvent.push({
        workflowName,
        eventName: `workflows_failed_batch${trigger.name ? `:${trigger.name}` : ''}`,
      });
      break;

    case 'job_complete':
      groups.kiciEvent.push({
        workflowName,
        eventName: `job_complete${trigger.workflow ? `:${trigger.workflow}` : ''}${trigger.job ? `.${trigger.job}` : ''}`,
      });
      break;
  }
}

export function displayEndpoints(groups: TriggerGroup, orgId: string): void {
  let hasOutput = false;
  let hasWebhookUrls = false;

  if (groups.gitProvider.length > 0) {
    hasOutput = true;
    hasWebhookUrls = true;
    logger.info(pc.bold('\nGit provider webhooks:'));
    const providers = [...new Set(groups.gitProvider.map((g) => g.provider))];
    for (const provider of providers) {
      const urlPath = `/webhook/${orgId}/${provider.toLowerCase()}`;
      logger.info(`  ${pc.cyan(provider + ':')}  ${urlPath}`);
    }
  }

  if (groups.genericWebhook.length > 0) {
    hasOutput = true;
    hasWebhookUrls = true;
    logger.info(pc.bold('\nGeneric webhooks:'));
    const seen = new Set<string>();
    for (const gw of groups.genericWebhook) {
      if (seen.has(gw.source)) continue;
      seen.add(gw.source);
      const urlPath = `/webhook/${orgId}/generic/${gw.source}`;
      logger.info(`  ${pc.cyan((gw.source + ':').padEnd(16))} ${urlPath}`);
    }
  }

  if (groups.schedule.length > 0) {
    hasOutput = true;
    logger.info(pc.bold('\nScheduled workflows:'));
    for (const s of groups.schedule) {
      const tz = s.timezone !== 'UTC' ? ` (${s.timezone})` : ' (UTC)';
      const label = s.description ?? s.workflowName;
      logger.info(`  ${pc.cyan((label + ':').padEnd(24))} "${s.cron}"${tz}`);
    }
  }

  const eventDriven = [
    ...groups.lifecycle.map((l) => ({
      workflowName: l.workflowName,
      description: l.description ?? l.workflowName,
      listensFor: `lifecycle (${l.events.join(', ')})`,
    })),
    ...groups.kiciEvent.map((k) => ({
      workflowName: k.workflowName,
      description: k.workflowName,
      listensFor: `kici_event (${k.eventName})`,
    })),
  ];

  if (eventDriven.length > 0) {
    hasOutput = true;
    logger.info(pc.bold('\nEvent-driven workflows:'));
    for (const e of eventDriven) {
      logger.info(`  ${pc.cyan((e.description + ':').padEnd(24))} listens for: ${e.listensFor}`);
    }
  }

  if (!hasOutput) {
    logger.info(pc.yellow('\nNo webhook entrypoints found in the lock file.'));
    logger.info(
      pc.gray('Add triggers to your workflows and run `kici compile` to generate endpoints.'),
    );
  }

  if (hasWebhookUrls && orgId === '{orgId}') {
    logger.info(
      pc.gray(
        '\nHint: Run `kici login` and `kici org use <name>` to resolve the {orgId} placeholder.',
      ),
    );
  }

  logger.info('');
}
