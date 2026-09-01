/**
 * Registry-host extraction for container image references.
 *
 * Lives in the engine because three sites need the same answer: the agent's
 * container sandbox, the container scaler backend, and the bare-metal backend
 * in container mode. A private pull authenticates against the registry HOST,
 * which is not a field of the image ref — it has to be derived from it.
 */

/**
 * Registry host (a container runtime's `authconfig.serveraddress`) for an image ref.
 *
 * Docker's own rule: the first path segment is the registry only when it looks
 * like a host — it contains a dot or a colon, or it is exactly `localhost`.
 * Otherwise the ref is a Docker Hub short name (`nginx`, `acme/ci`) and the
 * registry is `docker.io`.
 */
export function registryHostFromImageRef(image: string): string {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) return 'docker.io';

  const candidate = image.slice(0, firstSlash);
  const looksLikeHost =
    candidate.includes('.') || candidate.includes(':') || candidate === 'localhost';
  return looksLikeHost ? candidate : 'docker.io';
}
