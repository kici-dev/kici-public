import { z } from 'zod';

/** How the orchestrator process itself was deployed (not how it runs agents). */
export const DeploymentModeSchema = z.enum(['systemd', 'launchd', 'windows', 'compose', 'unknown']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

/** Container runtime that launched a `compose`-mode orchestrator. */
export const DeploymentContainerRuntimeSchema = z.enum(['podman', 'docker']);
export type DeploymentContainerRuntime = z.infer<typeof DeploymentContainerRuntimeSchema>;

/**
 * The orchestrator's self-reported deployment shape, from which the dashboard
 * Infrastructure page builds the right kici-admin invocation. Container fields
 * are set only in `compose` mode; a hand-run orchestrator reports
 * `mode: 'unknown'` with none.
 *
 * `adminInvocation` (posix bare metal: `systemd` / `launchd`) is the pinned
 * `<node> <kici-admin>` command, built from the orchestrator's own
 * `process.execPath` so a copied command runs under the unit's pinned runtime,
 * not whatever `node` the operator's shell resolves. It is a shell command, not
 * a pair of raw paths: either half is single-quoted (POSIX `'\''` escaping) when
 * its path holds whitespace or another shell metacharacter, so it pastes as-is.
 * A display-only reader needs no handling; a reader extracting the shim path
 * splits it as shell words, not on the last space.
 *
 * `adminPath` (`mode: 'windows'` only) is the absolute path of the
 * `kici-admin.cmd` launcher, RAW and never quoted or escaped: cmd.exe runs a
 * double-quoted path in command position while PowerShell only *prints* it (it
 * needs the `&` call operator), so only the reader knows how to write it.
 *
 * Both are live-host runtime paths carried only on the in-memory identity
 * (never persisted), and omitted when the orchestrator cannot locate the file,
 * so a reader falls back to a PATH-resolved bare `kici-admin` /
 * `kici-admin.cmd`.
 */
export const DeploymentIdentitySchema = z.object({
  mode: DeploymentModeSchema,
  containerName: z.string().min(1).optional(),
  containerRuntime: DeploymentContainerRuntimeSchema.optional(),
  adminInvocation: z.string().min(1).optional(),
  adminPath: z.string().min(1).optional(),
});
export type DeploymentIdentity = z.infer<typeof DeploymentIdentitySchema>;
