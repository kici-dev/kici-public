/**
 * Whether a Windows service launch runs a release that reads KICI_ENV_FILE.
 *
 * A Windows service gets its env file's path, never its values: any local
 * account reads a service command line with `sc.exe qc`. An older release
 * ignores the path, and running it would put the values back on the command
 * line, so every command that registers or switches a Windows service refuses
 * such a release before it changes anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_ENV_FILE_VAR } from '@kici-dev/shared/service-env-file';

/** Published, and imported first in each entry, only by a release that reads KICI_ENV_FILE. */
export const ENV_FILE_LOADER_EXPORT = './load-service-env-file';

/**
 * A bundle holds the variable name only when its release reads KICI_ENV_FILE.
 * The loader's module name is no evidence: an unminified bundle names every
 * inlined module in a comment.
 */
const BUNDLE_MARKER = SERVICE_ENV_FILE_VAR;

/** An npm entry imports the loader only when its release reads KICI_ENV_FILE. */
const ENTRY_MARKER = '@kici-dev/shared/load-service-env-file';

/** The orchestrator or agent entry of an npm install, as `install` registers it. */
const PACKAGE_ENTRY =
  /[/\\]@kici-dev[/\\](?:orchestrator|agent)[/\\]dist[/\\](?:server|standalone)\.js$/;

/** Whether `file` holds `marker`, or undefined when it cannot be read. */
function fileHolds(file: string, marker: string): boolean | undefined {
  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  return content.includes(marker);
}

/** The npm entry among the arguments, or else the executable itself. */
export function launchedRelease(launch: { executablePath: string; args?: string[] }): string {
  return launch.args?.find((arg) => PACKAGE_ENTRY.test(arg)) ?? launch.executablePath;
}

/**
 * A KiCI package runs `<dir>\<name>.cmd` beside the bundle `<dir>\lib\<name>.cjs`;
 * an npm install runs node with `@kici-dev/<component>/dist/<entry>.js`. Any
 * other launch (no KiCI bundle beside it, a custom executable) is taken to read it.
 */
export function launchReadsEnvFile(launch: { executablePath: string; args?: string[] }): boolean {
  const { executablePath } = launch;
  if (/\.(cmd|bat)$/i.test(executablePath)) {
    const { dir, name } = path.win32.parse(executablePath);
    // Joined with the separator the launcher path itself uses.
    const sep = executablePath.includes('\\') ? '\\' : '/';
    return fileHolds(`${dir}${sep}lib${sep}${name}.cjs`, BUNDLE_MARKER) ?? true;
  }
  const entry = launchedRelease(launch);
  return PACKAGE_ENTRY.test(entry) ? (fileHolds(entry, ENTRY_MARKER) ?? true) : true;
}

export function envFileRefusal(release: string, envFilePath: string): string {
  return (
    `${release} predates KICI_ENV_FILE, so a Windows service can run it only with the values ` +
    `of ${envFilePath} on its command line, where any local account can read them with ` +
    `sc.exe qc. Use a release that reads KICI_ENV_FILE. To run that release anyway, ` +
    `uninstall the service and install it with the kici-admin of that release.`
  );
}
