/**
 * The container runtime behind a configured socket path.
 *
 * A path containing `podman` is Podman; any other path is Docker. The container
 * backend reads a configured `socketPath` this way, and the runtime it picks
 * only labels the agents' log source and the scaler diagnostics.
 */
export function containerRuntimeForSocketPath(socketPath: string): 'docker' | 'podman' {
  return socketPath.includes('podman') ? 'podman' : 'docker';
}
