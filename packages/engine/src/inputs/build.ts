import { z } from 'zod';
import type { InputDescriptorT, InputsDescriptorMap } from './descriptor.js';

/** Build the base (unwrapped) coercing schema for a descriptor. */
function base(d: InputDescriptorT): z.ZodType {
  switch (d.type) {
    case 'string': {
      let s = z.string();
      if (d.min !== undefined) s = s.min(d.min);
      if (d.max !== undefined) s = s.max(d.max);
      if (d.pattern !== undefined) s = s.regex(new RegExp(d.pattern));
      return s;
    }
    case 'number':
    case 'integer': {
      let n = z.coerce.number();
      if (d.type === 'integer') n = n.int();
      if (d.min !== undefined) n = n.min(d.min);
      if (d.max !== undefined) n = n.max(d.max);
      return n;
    }
    case 'boolean':
      // string→bool: "true"/"false"/"1"/"0"/"yes"/"no". NOT z.coerce.boolean()
      // — z.coerce.boolean("false") === true is a confirmed footgun.
      return z.stringbool();
    case 'enum':
      return z.enum((d.values ?? []) as [string, ...string[]]);
    case 'literal':
      return z.literal(d.literal as string | number | boolean);
  }
}

/** Rebuild a real coercing Zod schema from a descriptor. */
export function buildZodFromDescriptor(d: InputDescriptorT): z.ZodType {
  let schema = base(d);
  if (d.nullable) schema = schema.nullable();
  if (d.default !== undefined) schema = schema.default(d.default);
  else if (d.optional) schema = schema.optional();
  return schema;
}

/** Rebuild a strict (unknown-key-rejecting) `z.object` from a descriptor map. */
export function buildZodObjectFromMap(map: InputsDescriptorMap) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, d] of Object.entries(map)) shape[k] = buildZodFromDescriptor(d);
  return z.object(shape).strict();
}
