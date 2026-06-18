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
