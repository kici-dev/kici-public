/**
 * Generic orchestrator-initiated request/response correlation over the Platform
 * WS. The orchestrator generates a requestId, registers a deferred, sends a
 * typed request, and resolves when the Platform echoes a `.response` with the
 * same requestId. The mirror of the Platform's dashboard-RPC forward window,
 * reversed. Transport failures (timeout, connection close) reject the deferred;
 * protocol-level errors travel inside the response body, not as rejections.
 */
interface Pending {
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Platform->orch message types that resolve a pending orch-initiated request. */
export const ORCH_RPC_RESPONSE_TYPES: ReadonlySet<string> = new Set(['oidc.mint.response']);

export class OrchRpcRegistry {
  private readonly pending = new Map<string, Pending>();

  register(requestId: string, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`orch RPC ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  resolve(requestId: string, msg: unknown): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(msg);
  }

  rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
