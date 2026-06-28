/**
 * Fixture factory for defining test event replicas.
 *
 * Fixtures declare which trigger event to simulate when running
 * `kici run remote <name>`. They are event replicas (not assertions) --
 * pass/fail is determined by the pipeline execution.
 */

import type { TriggerConfig } from './triggers/types.js';

/** Options for configuring a test fixture */
export interface FixtureOptions {
  /** The trigger event to simulate (reuses existing SDK trigger types) */
  event: TriggerConfig;
  /** Override branch name (defaults to git-detected) */
  branch?: string;
  /** Override commit SHA (defaults to HEAD) */
  sha?: string;
  /** Override repository (defaults to git-detected) */
  repo?: string;
  /** For PR events, override PR number */
  pr?: number;
  /** Secret context mappings: { localName: 'remote-context-name' } */
  secrets?: Record<string, string>;
  /** If set, bypass trigger matching and run this workflow directly */
  workflowName?: string;
}

/** Resolved fixture definition */
export interface Fixture {
  /** Unique fixture ID used in `kici run remote <name>` */
  readonly id: string;
  /** Fixture options (plain object or async factory function) */
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
  // Validate id is non-empty
  if (!id || id.length === 0) {
    throw new Error('Fixture ID must be a non-empty string');
  }

  // Validate id has no whitespace
  if (/\s/.test(id)) {
    throw new Error(`Fixture ID must not contain whitespace: "${id}"`);
  }

  // If options is a plain object, freeze both the fixture and its options
  if (typeof options === 'function') {
    // Async factory -- store as-is, resolution happens at runtime
    return Object.freeze({ id, options });
  }

  // Plain object -- freeze options and the fixture itself
  const frozenOptions = Object.freeze(options);
  return Object.freeze({ id, options: frozenOptions });
}
