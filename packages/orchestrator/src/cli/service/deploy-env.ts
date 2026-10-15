/**
 * The orchestrator reports its deployment shape in `source.register` so the
 * dashboard can build the right `kici-admin` invocation. Only the installer
 * knows the shape (a container cannot learn its own name), so it writes
 * `KICI_DEPLOY_*` vars into the env file.
 */
import { composeFilePath } from './compose-path.js';
import type { ServicePlatform } from './types.js';

export interface DeployEnvInput {
  platform: ServicePlatform;
  /** = ServiceConfig.name. */
  serviceName: string;
  /** `compose` platform only. */
  containerRuntime?: 'podman' | 'docker';
  /**
   * Stamped into the file because the process cannot derive it: systemd's
   * `EnvironmentFile=` passes no filename, and a container never sees the host path.
   */
  envFilePath: string;
}

/** Also the strip marker for idempotent re-install. */
const DEPLOY_ENV_PREFIX = 'KICI_DEPLOY_';

/** Container lines only for `compose`, the one shape with a container and a compose file. */
export function buildDeployEnvLines(input: DeployEnvInput): string[] {
  const lines = [
    `KICI_DEPLOY_MODE=${input.platform}`,
    `KICI_DEPLOY_CONFIG_FILE=${input.envFilePath}`,
  ];
  if (input.platform === 'compose') {
    lines.push(`KICI_DEPLOY_CONTAINER=${input.serviceName}`);
    if (input.containerRuntime) {
      lines.push(`KICI_DEPLOY_CONTAINER_RUNTIME=${input.containerRuntime}`);
    }
    lines.push(`KICI_DEPLOY_COMPOSE_FILE=${composeFilePath(input.envFilePath, input.serviceName)}`);
  }
  return lines;
}

/** Idempotent: existing `KICI_DEPLOY_*` lines are stripped so a re-install heals the shape. */
export function upsertDeployEnvLines(existingContent: string, lines: string[]): string {
  const kept = existingContent
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(DEPLOY_ENV_PREFIX));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const body = kept.join('\n');
  const prefix = body.length > 0 ? `${body}\n` : '';
  return `${prefix}${lines.join('\n')}\n`;
}
