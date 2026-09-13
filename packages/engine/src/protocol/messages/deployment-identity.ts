import { z } from 'zod';

/** How the orchestrator process itself was deployed (not how it runs agents). */
export const DeploymentModeSchema = z.enum(['systemd', 'launchd', 'windows', 'compose', 'unknown']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

/** Container runtime that launched a `compose`-mode orchestrator. */
export const DeploymentContainerRuntimeSchema = z.enum(['podman', 'docker']);
export type DeploymentContainerRuntime = z.infer<typeof DeploymentContainerRuntimeSchema>;

/**
 * The orchestrator's self-reported deployment shape, used to build the correct
 * kici-admin invocation in the dashboard Infrastructure page. Container fields are
 * populated only for the `compose` mode; a hand-run orchestrator reports
 * `mode: 'unknown'` with no container fields. `adminInvocation` is the pinned
 * `<node> <kici-admin>` invocation for posix bare-metal (`systemd` / `launchd`),
 * set by the orchestrator from its own `process.execPath` so a copied command
 * runs under the unit's pinned runtime rather than whatever `node` the
 * operator's shell resolves. The orchestrator locates the shim on disk and omits
 * the field when it cannot, so a reader may always fall back to a PATH-resolved
 * bare `kici-admin`. It is a live-host runtime path, carried only on the
 * in-memory identity (never persisted).
 *
 * The value is a shell command, not a pair of raw paths: either half is
 * single-quoted (POSIX `'\''` escaping) when its path holds whitespace or another
 * shell metacharacter, so it can be pasted as-is. A reader that only displays it
 * needs no special handling; a reader that wants the shim path back out has to
 * split it as shell words rather than on the last space.
 *
 * `adminPath` is the Windows counterpart and is set only for `mode: 'windows'`:
 * the absolute path of the `kici-admin.cmd` launcher, when the orchestrator can
 * locate it. Unlike `adminInvocation` it is a RAW path and never a command —
 * nothing about it is quoted or escaped. That is deliberate: cmd.exe runs a
 * double-quoted path in command position while PowerShell merely *prints* it
 * (it needs the `&` call operator), so the same path has to be written two
 * different ways and only the reader knows which shell it is rendering for. A
 * producer that pre-quoted would take that choice away. It is a live-host
 * runtime path, carried only on the in-memory identity (never persisted), and
 * omitted when the launcher cannot be located so a reader falls back to a
 * PATH-resolved bare `kici-admin.cmd`.
 */
export const DeploymentIdentitySchema = z.object({
  mode: DeploymentModeSchema,
  containerName: z.string().min(1).optional(),
  containerRuntime: DeploymentContainerRuntimeSchema.optional(),
  adminInvocation: z.string().min(1).optional(),
  adminPath: z.string().min(1).optional(),
});
export type DeploymentIdentity = z.infer<typeof DeploymentIdentitySchema>;
