import { z } from 'zod';

/**
 * GitHub check run conclusion values.
 *
 * Used when posting commit status / check-run results back to the provider.
 * Access values: CheckRunConclusion.enum.success, CheckRunConclusion.enum.failure, etc.
 */
export const CheckRunConclusion = z.enum(['success', 'failure', 'cancelled', 'timed_out']);
export type CheckRunConclusion = z.infer<typeof CheckRunConclusion>;
