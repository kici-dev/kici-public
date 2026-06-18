/**
 * Fixture generation command
 *
 * Generates JSON fixture templates for all supported event types,
 * including internal events (schedule, lifecycle, generic_webhook, kici_event).
 */

import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { getDefaultFixture } from '../fixtures/defaults/index.js';
import { detectRepoFromGit } from '../test-runner/git-detector.js';
import { parseEventArg } from '../test-runner/event-types.js';

export interface FixtureOptions {
  output?: string;
}

/** Internal event types that don't have GitHub webhook fixture files */
const INTERNAL_EVENT_TYPES = new Set([
  'kici_event',
  'workflow_complete',
  'job_complete',
  'generic_webhook',
  'schedule',
  'lifecycle',
]);

/**
 * Generate a fixture template for an internal event type.
 */
function generateInternalFixture(eventType: ReturnType<typeof parseEventArg>): unknown {
  switch (eventType.type) {
    case 'schedule':
      return {
        cronExpression:
          'cronExpression' in eventType && eventType.cronExpression
            ? eventType.cronExpression
            : '0 0 * * *',
        timezone: 'timezone' in eventType && eventType.timezone ? eventType.timezone : 'UTC',
      };

    case 'lifecycle':
      return {
        lifecycleEvent:
          'lifecycleEvent' in eventType ? eventType.lifecycleEvent : 'workflow_complete',
        workflowName: 'ci',
        status: 'success',
        sourceRepo: 'owner/repo',
      };

    case 'kici_event':
      return {
        eventName: 'eventName' in eventType ? eventType.eventName : 'test-event',
        payload: {
          message: 'Example payload',
        },
      };

    case 'workflow_complete':
      return {
        workflowName: 'workflowName' in eventType ? eventType.workflowName : 'ci',
        status: 'status' in eventType ? eventType.status : 'success',
        sourceRepo: 'owner/repo',
      };

    case 'job_complete':
      return {
        workflowName: 'workflowName' in eventType ? eventType.workflowName : 'ci',
        jobName: 'jobName' in eventType ? eventType.jobName : 'build',
        status: 'status' in eventType ? eventType.status : 'success',
        sourceRepo: 'owner/repo',
      };

    case 'generic_webhook':
      return {
        source: 'source' in eventType && eventType.source ? eventType.source : 'external-service',
        event: 'invoice.paid',
        payload: {
          id: 'evt_123',
          type: 'invoice.paid',
          data: {
            object: {
              id: 'in_123',
              amount_paid: 2000,
              currency: 'usd',
            },
          },
        },
      };

    default:
      return {};
  }
}

/**
 * Generate fixture template for event type
 */
export async function fixtureCommand(event: string, options: FixtureOptions): Promise<void> {
  try {
    // Parse the event to determine its type
    const eventType = parseEventArg(event);

    let result: unknown;

    if (INTERNAL_EVENT_TYPES.has(eventType.type)) {
      // Internal event types: generate template directly
      result = generateInternalFixture(eventType);
    } else {
      // GitHub event types: load from fixture files
      const fixture = getDefaultFixture(event);

      // Detect repo info from git
      const repoInfo = await detectRepoFromGit();

      // Apply repo overrides if detected
      result =
        repoInfo && typeof fixture === 'object' && fixture !== null
          ? {
              ...(fixture as Record<string, unknown>),
              repository: {
                ...((fixture as Record<string, unknown>).repository as Record<string, unknown>),
                owner: { login: repoInfo.owner },
                name: repoInfo.name,
                full_name: `${repoInfo.owner}/${repoInfo.name}`,
              },
            }
          : fixture;
    }

    const json = JSON.stringify(result, null, 2);

    if (options.output) {
      await writeFile(options.output, json, 'utf-8');
      logger.info(pc.green(`Fixture written to ${options.output}`));
    } else {
      logger.info(json);
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error(pc.red(`Error: ${error.message}`));
    }
    throw error;
  }
}
