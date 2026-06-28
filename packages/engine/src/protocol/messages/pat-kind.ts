import { z } from 'zod';

/**
 * Kind of personal access token.
 *
 * - `user` — an ordinary PAT acting as the human who minted it.
 * - `agent` — a PAT minted for a coding agent. It still runs with the user's
 *   permissions (no authority change), but its agent origin is carried into
 *   every audit / access-log row via `actor.agent`, and it is the only
 *   credential the developer MCP server accepts.
 */
export const PatKind = z.enum(['user', 'agent']);
export type PatKind = z.infer<typeof PatKind>;
