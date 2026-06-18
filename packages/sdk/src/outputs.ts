import type { OutputProxy } from './types.js';

/**
 * Well-known string property names that should delegate to Reflect rather than throwing.
 * These are accessed by built-in operations like JSON.stringify, console.log, iteration, etc.
 */
const WELL_KNOWN_STRING_PROPS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'toJSON',
  'then',
  'length',
  'nodeType',
  'tagName',
  'inspect',
  '$$typeof',
  'asymmetricMatch',
  '_tag',
]);

/**
 * Shared mutable map that steps write their outputs to and proxies read from.
 * Keys are step/job names, values are the outputs records.
 */
export type OutputsMap = Map<string, Record<string, unknown>>;

/**
 * WeakMap for mapping bare function references to step names.
 * Populated when the job normalizes bare functions into internal Step objects.
 */
export type StepRefMap = WeakMap<Function, string>;

/**
 * Structural type for step references used in resolveStepOutputs.
 * Avoids circular dependency with types.ts.
 */
interface StepLike {
  readonly _tag: 'Step';
  readonly name: string;
}

/**
 * Module-global outputs maps. Runners inject fresh maps at execution time
 * via setStepOutputsMap() / setJobOutputsMap().
 */
let _stepOutputsMap: OutputsMap = new Map();
let _jobOutputsMap: OutputsMap = new Map();
let _stepRefMap: StepRefMap = new WeakMap();

/**
 * Inject a fresh step outputs map for a new execution.
 * Called by workflow runners (compiler test runner, agent sandbox) before execution.
 */
export function setStepOutputsMap(map: OutputsMap): void {
  _stepOutputsMap = map;
}

/**
 * Inject a fresh job outputs map for a new execution.
 */
export function setJobOutputsMap(map: OutputsMap): void {
  _jobOutputsMap = map;
}

/**
 * Inject a fresh step-ref map for bare function -> step name resolution.
 */
export function setStepRefMap(map: StepRefMap): void {
  _stepRefMap = map;
}

/**
 * Get the current step outputs map (for runners to populate).
 */
export function getStepOutputsMap(): OutputsMap {
  return _stepOutputsMap;
}

/**
 * Get the current job outputs map (for runners to populate).
 */
export function getJobOutputsMap(): OutputsMap {
  return _jobOutputsMap;
}

/**
 * Get the current step ref map.
 */
export function getStepRefMap(): StepRefMap {
  return _stepRefMap;
}

/**
 * Create a Proxy over step outputs that resolves property access lazily
 * against the module-global step outputs map.
 *
 * @param stepName - The name of the step whose outputs to proxy
 * @returns A Proxy that resolves property access at runtime
 */
export function createStepOutputProxy<T>(stepName: string): OutputProxy<T> {
  return new Proxy({} as OutputProxy<T>, {
    get(_target, prop, receiver) {
      // Symbol properties: delegate to Reflect (JSON.stringify, iteration, etc.)
      if (typeof prop === 'symbol') {
        return Reflect.get(_target, prop, receiver);
      }

      // Well-known string properties: delegate to Reflect
      if (WELL_KNOWN_STRING_PROPS.has(prop)) {
        return Reflect.get(_target, prop, receiver);
      }

      const outputs = _stepOutputsMap.get(stepName);
      if (!outputs) {
        throw new Error(`Step '${stepName}' has not produced outputs yet`);
      }
      return outputs[prop];
    },

    ownKeys() {
      const outputs = _stepOutputsMap.get(stepName);
      if (!outputs) return [];
      return Reflect.ownKeys(outputs);
    },

    has(_target, prop) {
      const outputs = _stepOutputsMap.get(stepName);
      if (!outputs) return false;
      return prop in outputs;
    },

    getOwnPropertyDescriptor(_target, prop) {
      const outputs = _stepOutputsMap.get(stepName);
      if (!outputs) return undefined;
      if (prop in outputs) {
        return {
          configurable: true,
          enumerable: true,
          value: outputs[prop as string],
        };
      }
      return undefined;
    },
  });
}

/**
 * Create a Proxy over job outputs that resolves property access lazily
 * against the module-global job outputs map.
 *
 * For multi-step jobs: job.result.stepName.field
 * For single-step (run shorthand) jobs: job.result.field
 *
 * @param jobName - The name of the job whose outputs to proxy
 * @returns A Proxy that resolves property access at runtime
 */
export function createJobOutputProxy(jobName: string): OutputProxy<any> {
  return new Proxy({} as OutputProxy<any>, {
    get(_target, prop, receiver) {
      // Symbol properties: delegate to Reflect
      if (typeof prop === 'symbol') {
        return Reflect.get(_target, prop, receiver);
      }

      // Well-known string properties: delegate to Reflect
      if (WELL_KNOWN_STRING_PROPS.has(prop)) {
        return Reflect.get(_target, prop, receiver);
      }

      const outputs = _jobOutputsMap.get(jobName);
      if (!outputs) {
        throw new Error(`Job '${jobName}' has not produced outputs yet`);
      }
      return outputs[prop];
    },

    ownKeys() {
      const outputs = _jobOutputsMap.get(jobName);
      if (!outputs) return [];
      return Reflect.ownKeys(outputs);
    },

    has(_target, prop) {
      const outputs = _jobOutputsMap.get(jobName);
      if (!outputs) return false;
      return prop in outputs;
    },

    getOwnPropertyDescriptor(_target, prop) {
      const outputs = _jobOutputsMap.get(jobName);
      if (!outputs) return undefined;
      if (prop in outputs) {
        return {
          configurable: true,
          enumerable: true,
          value: outputs[prop as string],
        };
      }
      return undefined;
    },
  });
}

/**
 * Output proxy bound to a specific outputs object (not the module-global map).
 *
 * Used to expose a frozen upstream-job snapshot as `ctx.needs.<job>.result` for
 * result-aware dynamic generators. The snapshot is captured once at eval and
 * replayed unchanged on re-eval, so the proxy reads a fixed `outputs` object
 * rather than the live module-global job-outputs map.
 *
 * @param jobName - The upstream job whose outputs to proxy (used in error text)
 * @param outputs - The frozen outputs object, or undefined if the job produced none
 */
export function createSnapshotOutputProxy(
  jobName: string,
  outputs: Record<string, unknown> | undefined,
): OutputProxy<any> {
  return new Proxy({} as OutputProxy<any>, {
    get(_target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return Reflect.get(_target, prop, receiver);
      }
      if (WELL_KNOWN_STRING_PROPS.has(prop)) {
        return Reflect.get(_target, prop, receiver);
      }
      if (!outputs) {
        throw new Error(
          `Upstream job '${jobName}' has no frozen outputs in the generator snapshot`,
        );
      }
      return outputs[prop];
    },
    ownKeys() {
      return outputs ? Reflect.ownKeys(outputs) : [];
    },
    has(_target, prop) {
      return outputs ? prop in outputs : false;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!outputs) return undefined;
      if (prop in outputs) {
        return { configurable: true, enumerable: true, value: outputs[prop as string] };
      }
      return undefined;
    },
  });
}

/**
 * Resolve step outputs by step reference (Step object or bare function).
 * Used by ctx.outputsOf() implementation.
 *
 * @param ref - Step object (with _tag: 'Step') or bare function reference
 * @param outputsMap - The outputs map to resolve against (defaults to module-global)
 * @param refMap - The ref map for bare function -> name resolution (defaults to module-global)
 * @returns The step's outputs
 */
export function resolveStepOutputs<T>(
  ref: StepLike | Function,
  outputsMap?: OutputsMap,
  refMap?: StepRefMap,
): T {
  const map = outputsMap ?? _stepOutputsMap;
  const rMap = refMap ?? _stepRefMap;

  let stepName: string | undefined;

  if (typeof ref === 'function') {
    // Bare function reference -- look up in ref map
    stepName = rMap.get(ref);
    if (!stepName) {
      throw new Error(
        'Cannot resolve outputs for bare function: function not registered in step ref map',
      );
    }
  } else if (ref && typeof ref === 'object' && '_tag' in ref && ref._tag === 'Step') {
    stepName = ref.name;
  } else {
    throw new Error('Invalid step reference: expected Step object or bare function');
  }

  const outputs = map.get(stepName);
  if (!outputs) {
    throw new Error(`Step '${stepName}' has not produced outputs yet`);
  }
  return outputs as T;
}

/**
 * Resolve job outputs by job reference.
 * Used by ctx.jobOutputs() implementation.
 *
 * @param ref - Job object reference (needs .name property)
 * @param outputsMap - The outputs map to resolve against (defaults to module-global)
 * @returns The job's outputs
 */
export function resolveJobOutputs(
  ref: { name: string },
  outputsMap?: OutputsMap,
): Record<string, unknown> {
  const map = outputsMap ?? _jobOutputsMap;
  const outputs = map.get(ref.name);
  if (!outputs) {
    throw new Error(`Job '${ref.name}' has not produced outputs yet`);
  }
  return outputs;
}
