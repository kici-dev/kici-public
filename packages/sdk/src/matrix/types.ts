import type { $ as Shell } from 'zx';
import type { Logger } from '../context.js';

// Pure matrix value types live in @kici-dev/engine (so the orchestrator can
// expand matrices without depending on the SDK). Re-export them here so SDK
// consumers keep importing the same names.
export type {
  StaticMatrixArray,
  StaticMatrixObject,
  MatrixInclude,
  MatrixExclude,
  MatrixValues,
} from '@kici-dev/engine';

import type { StaticMatrixArray, StaticMatrixObject } from '@kici-dev/engine';

/**
 * Context passed to dynamic matrix functions.
 * Uses destructured form: async ({$, ctx, log, env}) => values
 */
export interface DynamicMatrixContext {
  /** zx shell executor for running commands */
  $: typeof Shell;
  /** Event context and workflow metadata */
  ctx: {
    workflow: { name: string };
    job: {
      name: string;
      runsOn: string | string[] | { labels: string | string[]; exclude?: string | string[] };
    };
  };
  /** Structured logger */
  log: Logger;
  /** Environment variables */
  env: Record<string, string | undefined>;
}

/**
 * Async function that computes matrix values dynamically.
 * Signature: async ({$, ctx, log, env}) => values
 */
export type DynamicMatrixFn = (
  context: DynamicMatrixContext,
) => Promise<StaticMatrixArray | StaticMatrixObject>;

/** Union type for all matrix forms */
export type Matrix = StaticMatrixArray | StaticMatrixObject | DynamicMatrixFn;

/** Type guard for static array matrices */
export function isStaticArray(m: Matrix): m is StaticMatrixArray {
  return Array.isArray(m);
}

/** Type guard for static object matrices */
export function isStaticObject(m: Matrix): m is StaticMatrixObject {
  // typeof null === 'object' in JS — guard against it explicitly even though
  // Matrix excludes null at the type level (callers may cast from unknown/any).
  return m !== null && typeof m === 'object' && !Array.isArray(m);
}

/** Type guard for dynamic function matrices */
export function isDynamicFunction(m: Matrix): m is DynamicMatrixFn {
  return typeof m === 'function';
}
