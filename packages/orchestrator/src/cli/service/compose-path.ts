import path from 'node:path';

/**
 * The generated compose file sits beside the env file, named for the service.
 * Its own module so the env-file writer need not import `compose.ts`, which
 * also detects a container runtime.
 */
export function composeFilePath(envFilePath: string, serviceName: string): string {
  return path.join(path.dirname(envFilePath), `${serviceName}-compose.yaml`);
}
