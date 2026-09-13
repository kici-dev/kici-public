import path from 'node:path';

/**
 * Where the generated compose file for a service lives: beside its env file,
 * named for the service.
 *
 * This sits in its own module because two callers need it and they cannot
 * share `compose.ts` — that module also detects a container runtime, which the
 * env-file writer has no business pulling in. One definition means the naming
 * convention is written down once rather than re-derived at each site.
 */
export function composeFilePath(envFilePath: string, serviceName: string): string {
  return path.join(path.dirname(envFilePath), `${serviceName}-compose.yaml`);
}
