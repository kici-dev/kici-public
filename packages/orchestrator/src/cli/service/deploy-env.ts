/**
 * Deployment-identity env injection for the orchestrator installer.
 *
 * The orchestrator reports its own deployment shape (systemd / launchd /
 * windows / compose) in `source.register` so the dashboard can build the
 * correct `kici-admin` invocation. The shape is only knowable at install time
 * (a running container can't learn its own container name), so the installer
 * injects it into the orchestrator's env file via these `KICI_DEPLOY_*` vars.
 */
import type { ServicePlatform } from './types.js';

/** Inputs the installer already has when it writes the env file. */
export interface DeployEnvInput {
  platform: ServicePlatform;
  /** The service / container name the installer assigns (= ServiceConfig.name). */
  serviceName: string;
  /** Container runtime, only meaningful for the `compose` platform. */
  containerRuntime?: 'podman' | 'docker';
}

/** Prefix every line uses; also the strip marker for idempotent re-install. */
const DEPLOY_ENV_PREFIX = 'KICI_DEPLOY_';

/**
 * Build the `KICI_DEPLOY_*` env lines for a given deployment shape. The mode
 * line is always emitted; container name + runtime are emitted only for the
 * `compose` platform (the only shape with a container to `exec` into).
 */
export function buildDeployEnvLines(input: DeployEnvInput): string[] {
  const lines = [`KICI_DEPLOY_MODE=${input.platform}`];
  if (input.platform === 'compose') {
    lines.push(`KICI_DEPLOY_CONTAINER=${input.serviceName}`);
    if (input.containerRuntime) {
      lines.push(`KICI_DEPLOY_CONTAINER_RUNTIME=${input.containerRuntime}`);
    }
  }
  return lines;
}

/**
 * Append the freshly-computed deploy lines to existing env-file content,
 * idempotently: any pre-existing `KICI_DEPLOY_*` line is stripped first so a
 * re-install / upgrade heals the shape rather than duplicating it.
 */
export function upsertDeployEnvLines(existingContent: string, lines: string[]): string {
  const kept = existingContent
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(DEPLOY_ENV_PREFIX));
  // Drop trailing blank lines so the block sits flush, then re-add one newline.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const body = kept.join('\n');
  const prefix = body.length > 0 ? `${body}\n` : '';
  return `${prefix}${lines.join('\n')}\n`;
}
