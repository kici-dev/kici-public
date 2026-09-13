/**
 * Event definition helper for creating typed event schemas.
 * Uses Zod for schema validation, re-exported from @kici-dev/sdk.
 */

import type { z } from 'zod';

/** Discriminant tag stamped on every value produced by {@link defineEvent}. */
export const EVENT_DEFINITION_TAG = 'EventDefinition' as const;

/**
 * A typed event definition with a name and Zod validation schema.
 * Used to define custom events that can be emitted from steps via ctx.emit().
 */
export interface EventDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly _tag: typeof EVENT_DEFINITION_TAG;
  readonly name: string;
  readonly schema: T;
}

/**
 * Create a typed event definition with a Zod schema.
 * Event definitions serve as the contract for custom event payloads.
 *
 * @example
 * import { defineEvent, z } from '@kici-dev/sdk';
 *
 * export const deployComplete = defineEvent('deploy-complete', z.object({
 *   env: z.string(),
 *   version: z.string(),
 *   services: z.array(z.string()),
 * }));
 *
 * // In a step (the definition drives payload type-checking):
 * await ctx.emit(deployComplete, { env: 'prod', version: '1.2.3', services: ['api'] });
 */
export function defineEvent<T extends z.ZodTypeAny>(name: string, schema: T): EventDefinition<T> {
  return Object.freeze({
    _tag: EVENT_DEFINITION_TAG,
    name,
    schema,
  });
}

/**
 * Runtime type guard: true when `value` is an event definition produced by
 * `defineEvent()`. Lets `ctx.emit(definition, payload)` accept either an event
 * name string or a definition object, resolving the name from the object.
 */
export function isEventDefinition(value: unknown): value is EventDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tag?: unknown })._tag === EVENT_DEFINITION_TAG &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}
