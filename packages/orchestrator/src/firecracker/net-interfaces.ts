/**
 * Interface patterns the Firecracker host setup marks unmanaged in
 * NetworkManager.
 *
 * A leaf module on purpose: it imports nothing, so an out-of-package consumer
 * can read the constant without pulling the orchestrator runtime graph in with
 * it. The NetworkManager drift watchdog (`hack/lib/nm-watchdog.ts`) derives its
 * expected-pattern set from here rather than re-typing the patterns — a second
 * copy desyncs silently the moment a pattern is added. `host-network.ts`
 * re-exports it and renders `NM_CONF_CONTENT` from it, so the drop-in and the
 * watchdog can never disagree.
 */
export const FIRECRACKER_NET_INTERFACES = ['kici-*'] as const;
