/**
 * Safe, fixed messages the orchestrator sends to the agent (and through it to
 * the workflow author) when an agent-WS request fails for an internal reason.
 *
 * They are presentation strings, not a wire vocabulary: they ride the free-text
 * `reason` of `step.approval-resolved` and `error` of `event.emit.response` /
 * `agent.api.response`, so rewording needs no agent change. One module keeps the
 * handler, its tests and the `onEventEmit` callback in `app.ts` from drifting.
 *
 * Raw exception text is never sent: it stays in the orchestrator logs, so the
 * author never sees a database endpoint, a constraint name or a stack frame.
 * Author-actionable failures (an unknown job context, an approval bridge's
 * timeout reason) ride the callback's return value with their own safe wording,
 * specific enough to debug a bad workflow without operator log access.
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
