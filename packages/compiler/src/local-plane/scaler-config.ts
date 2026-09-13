/**
 * Bare-metal scaler configuration for the local dev plane.
 *
 * A dispatched job needs an agent to run it. The plane orchestrator boots with
 * a single bare-metal scaler pointed at a label set matching the default
 * `runsOn` (`default`), so an offline `kici run --local` dispatch auto-spawns an
 * ephemeral, one-job-then-exit agent on this machine. The spawned binary is a
 * small executable wrapper that execs `node <@kici-dev/agent server entry>` —
 * mirroring the shape proven by the `local-file-source` E2E, and avoiding a
 * dependency on the (non-executable) shipped `kici-agent` script.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { planePaths } from './paths.js';

/** Resolve the built `@kici-dev/agent` server entry the bare-metal scaler runs. */
export function resolveAgentBinary(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@kici-dev/agent/server');
}

/**
 * Write the executable wrapper the bare-metal scaler spawns. The scaler invokes
 * `spawn(binaryPath, [])` directly, so the target must be an executable file;
 * the shipped agent entry is a plain Node module without an exec bit, so this
 * wrapper bridges the gap. Returns the wrapper path.
 */
export function writeAgentWrapper(): string {
  const { agentWrapperFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  const server = resolveAgentBinary();
  fs.writeFileSync(
    agentWrapperFile,
    `#!/usr/bin/env bash\nexec node ${JSON.stringify(server)} "$@"\n`,
  );
  fs.chmodSync(agentWrapperFile, 0o755);
  return agentWrapperFile;
}

/**
 * The non-reserved routing label a `kici run --local --trusted` run appends to
 * every job's `runsOn` so the dispatch lands on the plane's trusted label set.
 * `self-hosted` (not a `kici:`-prefixed reserved label) is also the `runsOn` the
 * CI deploy/CDN workflows already declare, so those route to the trusted profile
 * on this plane by construction.
 */
export const TRUSTED_ROUTING_LABEL = 'self-hosted';

/**
 * The non-reserved routing label a `kici run --local --trusted --in-place` run
 * appends (alongside `self-hosted`) so the dispatch lands on the plane's trusted
 * **in-place** label set — the agent runs the operator's real working tree
 * directly (no clone). This is the profile KiCI's own routed `deploy:stg` uses.
 */
export const IN_PLACE_ROUTING_LABEL = 'in-place';

/**
 * Write the plane's bare-metal scaler YAML and return its path. TWO coexisting
 * bare-metal scalers spawn the agent wrapper against the plane orchestrator's
 * localhost WS endpoint — a **sandboxed** pool and a `self-hosted`-**tainted**
 * TRUSTED pool:
 *
 * - `kici-local-bare-metal` (sandboxed) — one `default` label set, no taint. The
 *   credential-isolated profile a normal `kici run --local` dispatch (jobs with
 *   `runsOn: ['default']` or none) lands on. Its agents inherit no
 *   `mandatoryLabels`, so a bare `default` job routes here.
 * - `kici-local-bare-metal-trusted` (TRUSTED) — carries `mandatoryLabels:
 *   ['self-hosted']`, so ONLY a job that explicitly requests `self-hosted`
 *   (i.e. a `kici run --local --trusted` run, whose lock patch appends the
 *   `self-hosted` routing label, or a `runsOn: self-hosted` workflow) is ever
 *   routed to it — at BOTH the scaler spawn matcher AND the orchestrator's
 *   agent-registry dispatch gate. Two label sets:
 *     - `default` + `self-hosted` — the trusted fleet profile
 *       (`KICI_TRUSTED_ENV=true`, bwrap off): steps run with the ambient host
 *       env passed through, minus the agent's own KiCI identity secrets.
 *     - `default` + `self-hosted` + `in-place` — the trusted **in-place**
 *       profile (adds `KICI_IN_PLACE=true`) a `kici run --local --trusted
 *       --in-place` run lands on: same trusted env, but the agent uses the
 *       operator's real working tree directly (no clone) — the profile KiCI's
 *       own routed `deploy:stg` uses.
 *
 * The `self-hosted` taint is the isolation guarantee: without it, an idle
 * trusted agent (spawned for an earlier `--trusted` run and lingering for
 * follow-up jobs) would satisfy the agent-registry's subset match for a plain
 * `default` job and leak the ambient host env into a sandboxed run. The taint
 * closes that at the dispatch layer, not just the spawn heuristic.
 */
export function writeScalerConfig(orchestratorPort: number): string {
  const { scalerConfigFile, root } = planePaths();
  fs.mkdirSync(root, { recursive: true });
  const binaryPath = writeAgentWrapper();
  const orchestratorUrl = `ws://127.0.0.1:${orchestratorPort}/ws`;
  const yaml = stringifyYaml({
    version: 1,
    scalers: [
      {
        name: 'kici-local-bare-metal',
        type: 'bare-metal',
        maxAgents: 10,
        orchestratorUrl,
        labelSets: [{ labels: ['default'], binaryPath }],
      },
      {
        name: 'kici-local-bare-metal-trusted',
        type: 'bare-metal',
        maxAgents: 10,
        orchestratorUrl,
        // Taint: only jobs whose runsOn includes `self-hosted` may spawn on or
        // dispatch to this pool. Keeps a bare `default` run off every trusted
        // agent (default-off host-env passthrough is enforced by routing).
        mandatoryLabels: [TRUSTED_ROUTING_LABEL],
        labelSets: [
          {
            labels: ['default', TRUSTED_ROUTING_LABEL],
            binaryPath,
            env: { KICI_TRUSTED_ENV: 'true', KICI_SANDBOX: 'false' },
          },
          {
            labels: ['default', TRUSTED_ROUTING_LABEL, IN_PLACE_ROUTING_LABEL],
            binaryPath,
            env: { KICI_TRUSTED_ENV: 'true', KICI_SANDBOX: 'false', KICI_IN_PLACE: 'true' },
          },
        ],
      },
    ],
  });
  fs.writeFileSync(scalerConfigFile, yaml);
  return scalerConfigFile;
}
