/**
 * Bare-metal scalers for the local dev plane, so a `kici run --local` dispatch
 * spawns an ephemeral one-job agent on this machine. The spawned binary is an
 * executable wrapper that execs `node <@kici-dev/agent server entry>`, avoiding
 * the non-executable shipped `kici-agent` script.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { planePaths } from './paths.js';

export function resolveAgentBinary(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@kici-dev/agent/server');
}

/**
 * The scaler calls `spawn(binaryPath, [])`, so the target must be executable;
 * the shipped agent entry is a plain Node module without an exec bit.
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
 * Appended to every job's `runsOn` by `kici run --local --trusted`. Not a
 * reserved `kici:` label, and the `runsOn` the CI deploy/CDN workflows already
 * declare, so those route to the trusted profile by construction.
 */
export const TRUSTED_ROUTING_LABEL = 'self-hosted';

/**
 * Appended alongside `self-hosted` by `--trusted --in-place`: the agent runs the
 * operator's real working tree directly, with no clone.
 */
export const IN_PLACE_ROUTING_LABEL = 'in-place';

/**
 * Writes two bare-metal scalers against the plane's localhost WS endpoint:
 *
 * - `kici-local-bare-metal` (sandboxed): one `default` label set, no taint; a
 *   plain `kici run --local` job lands here.
 * - `kici-local-bare-metal-trusted`: `mandatoryLabels: ['self-hosted']`, so only
 *   a job requesting `self-hosted` routes here, at both the scaler spawn matcher
 *   and the agent-registry dispatch gate. Its `default` + `self-hosted` set
 *   passes the ambient host env through (bwrap off), minus the agent's own KiCI
 *   identity secrets; adding `in-place` also sets `KICI_IN_PLACE=true`.
 *
 * The taint is the isolation guarantee: without it, an idle trusted agent left
 * from an earlier `--trusted` run would subset-match a plain `default` job and
 * leak the host env into a sandboxed run.
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
