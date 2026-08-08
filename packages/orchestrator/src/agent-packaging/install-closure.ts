import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';
import { splitAgentPlatform, type AgentPlatform } from '@kici-dev/shared';

export interface InstallClosureOptions {
  version: string;
  platform: AgentPlatform;
  /** npm --prefix target; a package.json is seeded so npm installs into <prefix>/node_modules. */
  prefixDir: string;
  npmRegistry?: string;
}

/**
 * The `@kici-dev/agent@<spec>` argument for the install.
 *
 * In production the agent is published to npm at the exact single-version, so we
 * pin it verbatim (`@kici-dev/agent@0.2.0`) — the payload is provably the version
 * the orchestrator runs. In development (`KICI_DEV=true`) the local Verdaccio
 * registry only carries prerelease builds (`<version>-<buildCounter>`), so we
 * match the current base version's prereleases instead — the same
 * prerelease-compatible resolution the rest of the dev tooling uses.
 */
export function agentInstallSpec(version: string): string {
  if (process.env.KICI_DEV === 'true') return `@kici-dev/agent@^${version}-0`;
  return `@kici-dev/agent@${version}`;
}

/**
 * `npm install @kici-dev/agent@<version>` for the TARGET platform into prefixDir.
 *
 * `--cpu`/`--os` make npm resolve every transitive optional native binding (incl.
 * `@oxc-transform/binding-<platform>`) for the target platform, not the host —
 * the same mechanism `scripts/package.mjs` relies on for oxc. `--omit=dev` keeps
 * the closure to the runtime tree. When the published `@kici-dev/agent` ships an
 * `npm-shrinkwrap.json`, npm resolves the exact released + tested tree.
 */
export async function installAgentClosure(opts: InstallClosureOptions): Promise<void> {
  const { npmOs, npmCpu } = splitAgentPlatform(opts.platform);
  mkdirSync(opts.prefixDir, { recursive: true });
  // Seed a minimal package.json so `npm install --prefix` treats prefixDir as the root.
  writeFileSync(
    path.join(opts.prefixDir, 'package.json'),
    JSON.stringify({ name: 'kici-agent-payload', version: '0.0.0', private: true }) + '\n',
  );
  const spec = agentInstallSpec(opts.version);
  const registry = opts.npmRegistry ? ['--registry', opts.npmRegistry] : [];
  const out = await $({ nothrow: true, timeout: 300_000 })`npm install ${spec} \
    --prefix ${opts.prefixDir} --omit=dev --cpu=${npmCpu} --os=${npmOs} \
    --no-audit --no-fund --install-strategy=hoisted ${registry}`;
  if (out.exitCode !== 0) {
    throw new Error(`npm install of ${spec} (${npmOs}/${npmCpu}) failed:\n${out.stderr}`);
  }
}
