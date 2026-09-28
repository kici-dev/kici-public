/**
 * Whether a Windows service launch runs a release that reads KICI_ENV_FILE.
 *
 * A Windows service is registered with the path of its env file in
 * KICI_ENV_FILE, never with the values in the file: any local account reads the
 * command line of a service with `sc.exe qc`. A release from before
 * KICI_ENV_FILE ignores the path and starts without its configuration, and the
 * only registration that would run it puts the values back on the command line.
 * So every command that registers a Windows service, or switches one to another
 * release, refuses such a release before it changes anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_ENV_FILE_VAR } from '@kici-dev/shared/service-env-file';

/**
 * The `@kici-dev/shared` export that loads the env file KICI_ENV_FILE names. A
 * release publishes it, and imports it first in each entry, only when it reads
 * KICI_ENV_FILE.
 */
export const ENV_FILE_LOADER_EXPORT = './load-service-env-file';

/**
 * What a package bundle holds only when its release reads KICI_ENV_FILE: the
 * variable itself. The loader module's name is no evidence there, because an
 * unminified bundle names every module it inlines in a comment.
 */
const BUNDLE_MARKER = SERVICE_ENV_FILE_VAR;

/**
 * What an npm entry holds only when its release reads KICI_ENV_FILE: the import
 * of the loader, which each entry makes first.
 */
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

/**
 * The file that names a launch's release: the npm entry among its arguments,
 * or else the executable itself.
 */
export function launchedRelease(launch: { executablePath: string; args?: string[] }): string {
  return launch.args?.find((arg) => PACKAGE_ENTRY.test(arg)) ?? launch.executablePath;
}

/**
 * Whether the process a Windows service launch starts reads KICI_ENV_FILE.
 *
 * A KiCI package runs as `<dir>\<name>.cmd` beside its bundle
 * `<dir>\lib\<name>.cjs`, which names KICI_ENV_FILE when the release reads it.
 * An npm install runs node with the `@kici-dev/<component>/dist/<entry>.js`
 * entry, which then imports the env-file loader. Any other launch, such as a
 * batch file with no KiCI bundle beside it or a custom executable, is taken to
 * read it.
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

/**
 * Why a Windows service may not run `release`, a release from before
 * KICI_ENV_FILE, and what the operator can do instead.
 */
export function envFileRefusal(release: string, envFilePath: string): string {
  return (
    `${release} predates KICI_ENV_FILE, so a Windows service can run it only with the values ` +
    `of ${envFilePath} on its command line, where any local account can read them with ` +
    `sc.exe qc. Use a release that reads KICI_ENV_FILE. To run that release anyway, ` +
    `uninstall the service and install it with the kici-admin of that release.`
  );
}
