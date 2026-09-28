/**
 * Resolves the command a service unit should run.
 *
 * A `npm install -g kici-admin` install exposes only the `kici-admin` /
 * `kici-agent` CLI bins — the long-running orchestrator and agent servers are
 * separate module entry points (`dist/server.js` / `dist/standalone.js`) that
 * must be launched with `node <script>`. These helpers turn an install's
 * options into the `{ executablePath, args }` pair the platform service
 * managers write into the unit's run command.
 */

import { fileURLToPath } from 'node:url';

/** Server entry point variant for the orchestrator. */
export type ServerEntry = 'server' | 'standalone';

/** Resolved run command for a service unit. */
export interface ServiceExecutable {
  /** Program the unit runs (the Node binary, or an explicit self-launching binary). */
  executablePath: string;
  /** Arguments passed to the program (the resolved server script, or none). */
  args: string[];
}

/**
 * Pick the orchestrator server entry from an env file's `KICI_MODE`.
 * `independent` runs the standalone server; `platform` / `hybrid` / unset run
 * the Platform-connected server.
 */
export function selectServerEntry(envFileContent: string): ServerEntry {
  const match = envFileContent.match(/^[ \t]*KICI_MODE[ \t]*=[ \t]*(\S+)/m);
  return match && match[1].trim() === 'independent' ? 'standalone' : 'server';
}

/**
 * Build the `{ executablePath, args }` for a service unit.
 * - An explicit `binary` is run directly (assumed self-launching), no args.
 * - Otherwise the Node binary runs the resolved server `entryScript`.
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
 * The path of a server entry script installed beside this CLI, for a service
 * that runs `node <script>`. `resolve` is the calling module's
 * `import.meta.resolve`, or undefined where the CLI has none: a kici-admin from a
 * standalone package is a single CommonJS bundle that carries no orchestrator
 * or agent server. Either way the error names `--binary`, the launcher the
 * service runs instead.
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

/** A module's `import.meta.resolve`. */
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
