/**
 * Safe, fixed messages the orchestrator sends to the agent (and through it to
 * the workflow author) when an agent-WS request fails for an internal reason.
 *
 * These are presentation strings, not a wire vocabulary: the protocol carries
 * them in the free-text `reason` field of `step.approval-resolved` and in the
 * free-text `error` field of `event.emit.response` / `agent.api.response`, so an
 * orchestrator is free to reword them without any agent-side change. They live
 * in one module — rather than inline at each send site — so the handler, its
 * tests and the `onEventEmit` callback in `app.ts` cannot drift apart.
 *
 * Raw exception text is never one of these. Exceptions stay in the
 * orchestrator's own logs; the author sees only "this is an orchestrator
 * problem", never a database endpoint, a constraint name or a stack frame.
 *
 * Author-actionable failures do not come through here at all — they ride the
 * callback's return value with its own safe wording (an unknown job context, an
 * approval bridge's timeout reason), which stays specific enough to debug a bad
 * workflow without operator log access.
 */
export const AgentWsInternalFailure = Object.freeze({
  /** The step-approval bridge rejected instead of resolving the hold. */
  approvalFailed: 'the orchestrator hit an internal error while resolving this approval',
  /** The event router threw while emitting the agent's event. */
  eventEmitFailed: 'the orchestrator hit an internal error while emitting this event',
  /** An agent private-API handler threw for a reason other than its two deliberate rejections. */
  agentApiFailed: 'the orchestrator hit an internal error while handling this API request',
  /** The event-scaler claim store threw while minting ephemeral credentials. */
  scalerClaimFailed: 'the orchestrator hit an internal error while claiming scaler credentials',
} as const);
