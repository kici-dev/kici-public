import type { z } from 'zod';
import type { DispatchInputsMap } from './types.js';

/** The per-key inferred output type of a declared dispatch-inputs map. */
export type InferDispatchInputs<TMap extends DispatchInputsMap> = {
  [K in keyof TMap]: z.infer<TMap[K]>;
};

/** A context that may carry validated, coerced dispatch inputs. */
interface DispatchInputsCarrier {
  dispatchInputs?: Record<string, unknown>;
}

/**
 * A branded handle returned by `defineDispatchInputs`. It is accepted directly
 * by `dispatch({ inputs })` and exposes typed `.from(ctx)` / `.fromRule(ctx)`
 * readers over `ctx.dispatchInputs`, typed per declared key.
 */
export interface DefinedDispatchInputs<TMap extends DispatchInputsMap> {
  readonly __kiciDispatchInputs: true;
  readonly map: TMap;
  /** Read the validated, coerced dispatch inputs from a step context, typed per declared key. */
  from(ctx: DispatchInputsCarrier): InferDispatchInputs<TMap>;
  /** Same, from a rule context. */
  fromRule(ctx: DispatchInputsCarrier): InferDispatchInputs<TMap>;
}

/**
 * Declare a typed workflow-dispatch inputs map once and get back a handle that
 * both `dispatch({ inputs })` accepts and exposes a typed `.from(ctx)` reader —
 * no double type annotation. Type safety comes via Standard-Schema inference
 * (Zod 4 implements `~standard`), without a builder-generics refactor.
 */
export function defineDispatchInputs<TMap extends DispatchInputsMap>(
  map: TMap,
): DefinedDispatchInputs<TMap> {
  const read = (ctx: DispatchInputsCarrier): InferDispatchInputs<TMap> =>
    (ctx.dispatchInputs ?? {}) as InferDispatchInputs<TMap>;
  return Object.freeze({
    __kiciDispatchInputs: true as const,
    map: Object.freeze({ ...map }) as TMap,
    from: read,
    fromRule: read,
  });
}
