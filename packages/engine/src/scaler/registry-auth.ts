/**
 * Registry-host extraction for container image references, shared by the
 * agent's container sandbox, the container scaler backend and the bare-metal
 * backend in container mode. A private pull authenticates against the registry
 * HOST, which must be derived from the image ref.
 */

/**
 * Registry host (a container runtime's `authconfig.serveraddress`) for an image ref.
 *
 * Docker's rule: the first path segment is the registry only when it contains
 * a dot or a colon, or is exactly `localhost`; otherwise the ref is a Docker
 * Hub short name (`nginx`, `acme/ci`) and the registry is `docker.io`.
 */
export function registryHostFromImageRef(image: string): string {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) return 'docker.io';

  const candidate = image.slice(0, firstSlash);
  const looksLikeHost =
    candidate.includes('.') || candidate.includes(':') || candidate === 'localhost';
  return looksLikeHost ? candidate : 'docker.io';
}
