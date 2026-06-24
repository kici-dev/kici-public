import { z } from 'zod';

/** How the orchestrator process itself was deployed (not how it runs agents). */
export const DeploymentModeSchema = z.enum(['systemd', 'launchd', 'windows', 'compose', 'unknown']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

/** Container runtime that launched a `compose`-mode orchestrator. */
export const DeploymentContainerRuntimeSchema = z.enum(['podman', 'docker']);
export type DeploymentContainerRuntime = z.infer<typeof DeploymentContainerRuntimeSchema>;

/**
 * The orchestrator's self-reported deployment shape, used to build the correct
 * kici-admin invocation in the dashboard diagnostics page. Container fields are
 * populated only for the `compose` mode; a hand-run orchestrator reports
 * `mode: 'unknown'` with no container fields.
 */
export const DeploymentIdentitySchema = z.object({
  mode: DeploymentModeSchema,
  containerName: z.string().min(1).optional(),
  containerRuntime: DeploymentContainerRuntimeSchema.optional(),
});
export type DeploymentIdentity = z.infer<typeof DeploymentIdentitySchema>;
