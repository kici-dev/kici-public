/**
 * Resolves the command a service unit runs. `npm install -g kici-admin` exposes
 * only the `kici-admin` / `kici-agent` CLI bins; the orchestrator and agent
 * servers are module entry points (`dist/server.js` / `dist/standalone.js`)
 * launched with `node <script>`.
 */

import { fileURLToPath } from 'node:url';

export type ServerEntry = 'server' | 'standalone';

export interface ServiceExecutable {
  /** The Node binary, or an explicit self-launching binary. */
  executablePath: string;
  /** The resolved server script, or none. */
  args: string[];
}

/**
 * From `KICI_MODE`: `independent` runs the standalone server; `platform` /
 * `hybrid` / unset run the Platform-connected server.
 */
export function selectServerEntry(envFileContent: string): ServerEntry {
  const match = envFileContent.match(/^[ \t]*KICI_MODE[ \t]*=[ \t]*(\S+)/m);
  return match && match[1].trim() === 'independent' ? 'standalone' : 'server';
}

/**
 * An explicit `binary` runs directly (assumed self-launching), no args;
 * otherwise the Node binary runs the resolved server `entryScript`.
 */
export function resolveServiceExecutable(opts: {
  binary?: string;
  nodePath: string;
  entryScript?: string;
}): ServiceExecutable {
  if (opts.binary) {
    return { executablePath: opts.binary, args: [] };
  }
  if (!opts.entryScript) {
    throw new Error('resolveServiceExecutable: entryScript is required when no binary is given');
  }
  return { executablePath: opts.nodePath, args: [opts.entryScript] };
}

/**
 * The path of a server entry script installed beside this CLI. `resolve` is the
 * caller's `import.meta.resolve`, undefined in a standalone-package kici-admin
 * (a single CommonJS bundle with no orchestrator or agent server). The error
 * names `--binary`, the launcher the service runs instead.
 */
export function resolveServerScript(
  specifier: string,
  component: ServerComponent,
  resolve: ModuleResolver | undefined,
): string {
  let cause = NO_RESOLVER;
  if (resolve) {
    try {
      return fileURLToPath(resolve(specifier));
    } catch (err) {
      cause = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(missingServerMessage(component, specifier, cause));
}

/**
 * Refuse an install without `--binary` on a kici-admin that cannot resolve
 * installed packages, before the wizard runs or any file is written.
 */
export function assertServerResolvable(
  component: ServerComponent,
  binary: string | undefined,
  resolve: ModuleResolver | undefined,
): void {
  if (binary === undefined && resolve === undefined) {
    throw new Error(missingServerMessage(component, `@kici-dev/${component}`, NO_RESOLVER));
  }
}

type ServerComponent = 'orchestrator' | 'agent';

export type ModuleResolver = (specifier: string) => string;

const NO_RESOLVER = 'this kici-admin cannot resolve installed packages';

function missingServerMessage(
  component: ServerComponent,
  specifier: string,
  cause: string,
): string {
  return (
    `kici-admin cannot find the ${component} server (${specifier}): ${cause}. ` +
    `Pass --binary with the path of the ${component} launcher, such as the one in a ` +
    `standalone ${component} package.`
  );
}
