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
 * The `@kici-dev/agent@<spec>` install argument.
 *
 * In production it pins the exact single-version (`@kici-dev/agent@0.2.0`), so the payload is
 * provably the version the orchestrator runs. In development (`KICI_DEV=true`) local Verdaccio
 * carries only prereleases (`<version>-<buildCounter>`), so it matches the base version's
 * prereleases, as the rest of the dev tooling does.
 */
export function agentInstallSpec(version: string): string {
  if (process.env.KICI_DEV === 'true') return `@kici-dev/agent@^${version}-0`;
  return `@kici-dev/agent@${version}`;
}

/**
 * `npm install @kici-dev/agent@<version>` for the TARGET platform into prefixDir.
 *
 * `--cpu`/`--os` resolve every transitive optional native binding (incl.
 * `@oxc-transform/binding-<platform>`) for the target, not the host, as `scripts/package.mjs`
 * does for oxc. `--omit=dev` keeps the runtime tree only. A published `npm-shrinkwrap.json`
 * pins the exact released + tested tree.
 */
export async function installAgentClosure(opts: InstallClosureOptions): Promise<void> {
  const { npmOs, npmCpu } = splitAgentPlatform(opts.platform);
  mkdirSync(opts.prefixDir, { recursive: true });
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
