/**
 * Dispatch trigger helper - creates triggers for repository_dispatch events.
 * Returns a frozen DispatchTriggerConfig directly.
 */

import type {
  BranchPattern,
  DispatchConfigInput,
  DispatchInputsMap,
  DispatchTriggerConfig,
} from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a repository dispatch trigger configuration.
 *
 * @example
 * // Match any dispatch event
 * dispatch()
 *
 * // Match specific event types
 * dispatch({ types: ['deploy', 'rollback'] })
 */
export function dispatch(config?: DispatchConfigInput): DispatchTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  // A defineDispatchInputs(...) handle carries the map under `.map`; a bare
  // `{ name: ZodSchema }` map is stored as-is.
  const rawInputs = config?.inputs;
  let inputsMap: DispatchInputsMap | undefined;
  if (rawInputs) {
    inputsMap =
      '__kiciDispatchInputs' in rawInputs
        ? (rawInputs as { map: DispatchInputsMap }).map
        : (rawInputs as DispatchInputsMap);
  }

  const result: DispatchTriggerConfig = {
    _tag: 'DispatchTrigger',
    types: Object.freeze(config?.types ? [...config.types] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
    ...(inputsMap && { inputs: Object.freeze({ ...inputsMap }) }),
  };

  return Object.freeze(result);
}
