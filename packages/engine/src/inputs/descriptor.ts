import { z } from 'zod';

/** The closed set of input value types persisted in the lockfile. */
export const DispatchInputType = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'literal',
]);
export type DispatchInputTypeT = z.infer<typeof DispatchInputType>;

/** JSON-safe, lossless descriptor of one declared dispatch input. */
export const InputDescriptor = z.object({
  type: DispatchInputType,
  optional: z.boolean().default(false),
  nullable: z.boolean().default(false),
  /** Present iff the author set `.default()`. */
  default: z.unknown().optional(),
  /** Enum members (type === 'enum'). */
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Literal value (type === 'literal'). */
  literal: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Regex source (type === 'string'). */
  pattern: z.string().optional(),
  description: z.string().optional(),
});
export type InputDescriptorT = z.infer<typeof InputDescriptor>;

export const InputsDescriptorMapSchema = z.record(z.string(), InputDescriptor);
export type InputsDescriptorMap = z.infer<typeof InputsDescriptorMapSchema>;
