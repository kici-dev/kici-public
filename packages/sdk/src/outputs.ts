import type { OutputProxy, SourceLocation } from './types.js';

/** Properties built-ins (JSON.stringify, console.log, iteration, …) probe; they delegate to Reflect instead of throwing. */
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

/** Step/job name → outputs; steps write it and proxies read it. */
export type OutputsMap = Map<string, Record<string, unknown>>;

/** Bare function → step name, filled when the job normalizes bare functions into Step objects. */
export type StepRefMap = WeakMap<Function, string>;

/** Structural step type; avoids a circular import of types.ts. */
interface StepLike {
  readonly _tag: 'Step';
  readonly name: string;
}

/** Module-global maps; runners inject fresh ones per execution via the setters below. */
let _stepOutputsMap: OutputsMap = new Map();
let _jobOutputsMap: OutputsMap = new Map();
let _stepRefMap: StepRefMap = new WeakMap();

/** Called by workflow runners (compiler test runner, agent sandbox) before execution. */
export function setStepOutputsMap(map: OutputsMap): void {
  _stepOutputsMap = map;
}

export function setJobOutputsMap(map: OutputsMap): void {
  _jobOutputsMap = map;
}

export function setStepRefMap(map: StepRefMap): void {
  _stepRefMap = map;
}

/** Runners populate this map. */
export function getStepOutputsMap(): OutputsMap {
  return _stepOutputsMap;
}

/** Runners populate this map. */
export function getJobOutputsMap(): OutputsMap {
  return _jobOutputsMap;
}

export function getStepRefMap(): StepRefMap {
  return _stepRefMap;
}

/**
 * What the step output proxy needs: a name that may be assigned after the proxy
 * exists (id-less steps become `step-N` at execution start), and a source
 * location for the error when it is still unresolved.
 */
export interface StepNameRef {
  readonly name: string;
  readonly _sourceLocation?: SourceLocation;
}

/**
 * Lazy proxy over the module-global step outputs map. It reads `stepRef.name` at
 * ACCESS time: id-less steps have `name === ''` when the proxy is built, and the
 * runner assigns `step-N` to the same object before any run function executes.
 */
export function createStepOutputProxy<T>(stepRef: StepNameRef): OutputProxy<T> {
  const unresolvedError = (): Error => {
    const loc = stepRef._sourceLocation;
    const at = loc ? ` (step defined at ${loc.file}:${loc.line})` : '';
    return new Error(
      `This step has no name yet; .result is only available inside another step's run ` +
        `function${at}. Name the step to reference its outputs before execution.`,
    );
  };

  return new Proxy({} as OutputProxy<T>, {
    get(_target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return Reflect.get(_target, prop, receiver);
      }

      if (WELL_KNOWN_STRING_PROPS.has(prop)) {
        return Reflect.get(_target, prop, receiver);
      }

      if (!stepRef.name) throw unresolvedError();
      const outputs = _stepOutputsMap.get(stepRef.name);
      if (!outputs) {
        throw new Error(`Step '${stepRef.name}' has not produced outputs yet`);
      }
      return outputs[prop];
    },

    ownKeys() {
      if (!stepRef.name) return [];
      const outputs = _stepOutputsMap.get(stepRef.name);
      if (!outputs) return [];
      return Reflect.ownKeys(outputs);
    },

    has(_target, prop) {
      if (!stepRef.name) return false;
      const outputs = _stepOutputsMap.get(stepRef.name);
      if (!outputs) return false;
      return prop in outputs;
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (!stepRef.name) return undefined;
      const outputs = _stepOutputsMap.get(stepRef.name);
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
 * Lazy proxy over the module-global job outputs map. Multi-step jobs:
 * `job.result.stepName.field`; single-step (run shorthand) jobs: `job.result.field`.
 */
export function createJobOutputProxy<TOutputs = any>(jobName: string): OutputProxy<TOutputs> {
  return new Proxy({} as OutputProxy<TOutputs>, {
    get(_target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return Reflect.get(_target, prop, receiver);
      }

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
 * Proxy over a fixed outputs object: the frozen upstream-job snapshot exposed as
 * `ctx.needs.<job>.result` to result-aware dynamic generators. The snapshot is
 * captured once at eval and replayed unchanged on re-eval.
 *
 * @param jobName - Used in error text
 * @param outputs - Undefined if the job produced none
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

/** Backs `ctx.outputsOf()`; both maps default to the module-global ones. */
export function resolveStepOutputs<T>(
  ref: StepLike | Function,
  outputsMap?: OutputsMap,
  refMap?: StepRefMap,
): T {
  const map = outputsMap ?? _stepOutputsMap;
  const rMap = refMap ?? _stepRefMap;

  let stepName: string | undefined;

  if (typeof ref === 'function') {
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

/** Backs `ctx.jobOutputs()`; `outputsMap` defaults to the module-global one. */
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
