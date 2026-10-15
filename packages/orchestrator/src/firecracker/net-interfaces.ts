/**
 * Interface patterns the Firecracker host setup marks unmanaged in
 * NetworkManager.
 *
 * A leaf module on purpose: an out-of-package consumer (a NetworkManager drift
 * watchdog) reads the constant without the orchestrator runtime graph, rather
 * than re-typing a copy that desyncs silently. `host-network.ts` renders
 * `NM_CONF_CONTENT` from it, so the drop-in and the watchdog never disagree.
 */
export const FIRECRACKER_NET_INTERFACES = ['kici-*'] as const;
