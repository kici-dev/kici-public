/**
 * Event definition helper for creating typed event schemas.
 * Uses Zod for schema validation, re-exported from @kici-dev/sdk.
 */

import type { z } from 'zod';

/**
 * A typed event definition with a name and Zod validation schema.
 * Used to define custom events that can be emitted from steps via ctx.emit().
 */
export interface EventDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly _tag: 'EventDefinition';
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
 * // In a step:
 * await ctx.emit(deployComplete.name, { env: 'prod', version: '1.2.3', services: ['api'] });
 */
export function defineEvent<T extends z.ZodTypeAny>(name: string, schema: T): EventDefinition<T> {
  return Object.freeze({
    _tag: 'EventDefinition' as const,
    name,
    schema,
  });
}
