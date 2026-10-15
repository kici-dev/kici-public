import { z } from 'zod';

/**
 * Which subprocess output stream a run-log line came from.
 *
 * Carried per log chunk, not per line: chunks arrive in order and the agent
 * closes the pending chunk whenever the kind flips, so interleaving survives.
 * A leaf module because the agent→orchestrator chunk, the orchestrator→Platform
 * relay and the Platform→browser fan-out all reference it; this keeps them acyclic.
 */
export const LogStream = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStream>;
