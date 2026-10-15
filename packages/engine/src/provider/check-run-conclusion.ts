import { z } from 'zod';

/**
 * GitHub check run conclusion values, used when posting commit status / check-run
 * results back to the provider (e.g. `CheckRunConclusion.enum.success`).
 */
export const CheckRunConclusion = z.enum(['success', 'failure', 'cancelled', 'timed_out']);
export type CheckRunConclusion = z.infer<typeof CheckRunConclusion>;
