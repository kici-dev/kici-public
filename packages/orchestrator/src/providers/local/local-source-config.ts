/**
 * Configuration for a local filesystem (`file://`) source, stored as JSONB in
 * `generic_webhook_sources.git_config` and discriminated from universal-git
 * config by the row's `provider_type='local'`.
 *
 * A local source clones a git repository that already exists on the agent's
 * filesystem (host path for bare-metal scalers, image-bundled / rootfs /
 * bind-mounted path for container + Firecracker scalers). The orchestrator does
 * not verify in-agent reachability — that is the operator's responsibility.
 */
import { z } from 'zod';
import path from 'node:path';

export const LocalSourceConfigSchema = z
  .object({
    /** Absolute path to the repo (or base dir of repos) on the agent filesystem. */
    repoBasePath: z
      .string()
      .min(1)
      .refine((p) => path.isAbsolute(p), { message: 'repoBasePath must be an absolute path' }),
    /** Optional network clone base (git:// / http://) for remote agents that do
     *  not share the orchestrator's filesystem. When unset, file:// is used. */
    cloneUrlBase: z.string().min(1).optional(),
    /**
     * In-place profile: the `repoBasePath` IS the operator's real working tree,
     * so a dispatched run skips the source-pack `__build__` job and each job runs
     * the tree directly (the agent, under its `KICI_IN_PLACE` profile, uses the
     * `file://` path as workDir with no clone). Set only by the local dev plane
     * for a `kici run --local --in-place` run. Only meaningful for `file://`
     * (no `cloneUrlBase`) local sources on a host-sharing scaler.
     */
    inPlace: z.boolean().optional(),
  })
  .strict();

export type LocalSourceConfig = z.infer<typeof LocalSourceConfigSchema>;
