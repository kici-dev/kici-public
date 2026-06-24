import {
  DeploymentModeSchema,
  DeploymentContainerRuntimeSchema,
  type DeploymentIdentity,
} from '@kici-dev/engine';

/**
 * Read the orchestrator's deployment shape from the env the installer injects
 * (`KICI_DEPLOY_MODE` / `KICI_DEPLOY_CONTAINER` / `KICI_DEPLOY_CONTAINER_RUNTIME`).
 * Hand-run / dev orchestrators carry no `KICI_DEPLOY_*` env and report `unknown`.
 * Container fields are kept only for the `compose` mode.
 */
export function readDeploymentIdentity(env: NodeJS.ProcessEnv = process.env): DeploymentIdentity {
  const modeResult = DeploymentModeSchema.safeParse(env.KICI_DEPLOY_MODE);
  const mode = modeResult.success ? modeResult.data : 'unknown';

  if (mode !== 'compose') {
    return { mode };
  }

  const identity: DeploymentIdentity = { mode };
  const containerName = env.KICI_DEPLOY_CONTAINER?.trim();
  if (containerName) identity.containerName = containerName;

  const runtimeResult = DeploymentContainerRuntimeSchema.safeParse(
    env.KICI_DEPLOY_CONTAINER_RUNTIME,
  );
  if (runtimeResult.success) identity.containerRuntime = runtimeResult.data;

  return identity;
}
