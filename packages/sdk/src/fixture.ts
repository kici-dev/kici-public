/**
 * Fixtures declare the trigger event `kici run remote <name>` simulates. They
 * are event replicas, not assertions: the pipeline run decides pass/fail.
 */

import type { TriggerConfig } from './triggers/types.js';

export interface FixtureOptions {
  /** The trigger event to simulate */
  event: TriggerConfig;
  /** Override branch name (defaults to git-detected) */
  branch?: string;
  /** Override commit SHA (defaults to HEAD) */
  sha?: string;
  /** Override repository (defaults to git-detected) */
  repo?: string;
  /** Override PR number (PR events) */
  pr?: number;
  /** Secret context mappings: { localName: 'remote-context-name' } */
  secrets?: Record<string, string>;
  /** Bypass trigger matching and run this workflow directly */
  workflowName?: string;
}

export interface Fixture {
  /** The `<name>` in `kici run remote <name>` */
  readonly id: string;
  readonly options: FixtureOptions | (() => FixtureOptions | Promise<FixtureOptions>);
}

/**
 * Create a test fixture definition.
 *
 * @param id - Unique fixture ID (no whitespace allowed, used in `kici run remote <name>`)
 * @param options - Fixture configuration or async factory function
 * @returns Frozen fixture definition
 *
 * @example
 * ```ts
 * import { fixture, push } from '@kici-dev/sdk';
 *
 * export const pushMain = fixture('push-main', {
 *   event: push({ branches: ['main'] }),
 * });
 * ```
 */
export function fixture(
  id: string,
  options: FixtureOptions | (() => FixtureOptions | Promise<FixtureOptions>),
): Fixture {
  if (!id || id.length === 0) {
    throw new Error('Fixture ID must be a non-empty string');
  }

  if (/\s/.test(id)) {
    throw new Error(`Fixture ID must not contain whitespace: "${id}"`);
  }

  if (typeof options === 'function') {
    // Resolved at runtime
    return Object.freeze({ id, options });
  }

  const frozenOptions = Object.freeze(options);
  return Object.freeze({ id, options: frozenOptions });
}
