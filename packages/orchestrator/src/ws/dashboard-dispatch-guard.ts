/**
 * Guarantees every forwarded dashboard request produces exactly one response
 * frame keyed to its requestId. Wraps the per-type dispatch so a thrown handler
 * or an unhandled message type returns a fast structured error instead of a
 * silently dropped frame (which the Platform would surface as a 10s 504 at its
 * forward window).
 */
export interface DashboardDispatchGuardDeps {
  /** Sends a raw frame back over the Platform WS. */
  sendRaw: (msg: unknown) => void;
  /** Runs the real per-type dispatch; resolves true if a handler owned the type. */
  dispatch: (msg: { type: string; requestId: string }) => Promise<boolean>;
}

export async function guardedDashboardDispatch(
  deps: DashboardDispatchGuardDeps,
  msg: { type: string; requestId: string },
): Promise<void> {
  try {
    const handled = await deps.dispatch(msg);
    if (!handled) {
      deps.sendRaw({
        type: `${msg.type}.response`,
        requestId: msg.requestId,
        error: `unsupported dashboard message type: ${msg.type}`,
      });
    }
  } catch (err) {
    deps.sendRaw({
      type: `${msg.type}.response`,
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
