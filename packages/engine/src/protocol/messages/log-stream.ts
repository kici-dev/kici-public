import { z } from 'zod';

/**
 * Which of a subprocess's two output streams a run-log line came from.
 *
 * Carried per log chunk rather than per line: chunks are delivered in order and
 * the agent closes the pending chunk whenever the kind flips, so stdout/stderr
 * interleaving is preserved without a per-line field.
 *
 * Lives in its own module because three protocol planes reference it — the
 * agent→orchestrator chunk, the orchestrator→Platform relay, and the
 * Platform→browser fan-out — and a shared leaf keeps those files acyclic.
 */
export const LogStream = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStream>;
