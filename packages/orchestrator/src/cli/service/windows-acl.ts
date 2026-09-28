/**
 * Restricting a Windows service's env file to the service account and to
 * Administrators.
 *
 * Node maps a file mode onto Windows by toggling the read-only attribute and
 * changes no ACL, so ENV_FILE_MODE protects nothing there. The instance folder
 * under C:\ProgramData\kici\ inherits read access for BUILTIN\Users from
 * C:\ProgramData. Its ACL is replaced with full control for LocalSystem (the
 * account the shawl service runs as) and Administrators, inherited by
 * everything created in it: the env file, the temporary file a secure write
 * stages it through, and the service logs are unreadable to other accounts
 * from the moment they exist.
 *
 * Every call passes `/L` and none recurses, so icacls acts on the folder and on
 * the env file themselves and never on what a link there points at. A
 * recursive `/reset` or `/setowner` descends into the target of a junction or
 * of a symbolic link, even with `/L`, and rewrites the ACL of the files there.
 * The new folder ACL still reaches every entry that inherits from the folder.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** NT AUTHORITY\SYSTEM, the account a shawl service runs as. */
export const LOCAL_SYSTEM_SID = 'S-1-5-18';

/** BUILTIN\Administrators. */
export const ADMINISTRATORS_SID = 'S-1-5-32-544';

/** Runs `icacls` with the given arguments; throws when it fails. */
export type IcaclsRunner = (args: string[]) => void;

/**
 * The icacls in the Windows system folder, which also holds the cmd.exe that
 * COMSPEC names. A bare `icacls` would also be looked up in the current
 * folder, and the install runs elevated.
 */
function icaclsPath(): string {
  const comspec = process.env.COMSPEC;
  const systemDir =
    comspec && /(^|\\)cmd\.exe$/i.test(comspec)
      ? path.win32.dirname(comspec)
      : 'C:\\Windows\\System32';
  return path.win32.join(systemDir, 'icacls.exe');
}

const runIcacls: IcaclsRunner = (args) => {
  execFileSync(icaclsPath(), args, { stdio: 'pipe' });
};

/**
 * The icacls arguments that remove every inherited ACE from `dir` and grant
 * full control, inherited by files and folders, to LocalSystem and
 * Administrators. SIDs rather than names, so a localized Windows resolves them.
 */
export function restrictDirArgs(dir: string): string[] {
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`,
    `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
    '/L',
    '/Q',
  ];
}

/** The icacls arguments that reset `file` to inherit only from its folder. */
export function resetFileArgs(file: string): string[] {
  return [file, '/reset', '/L', '/Q'];
}

/**
 * Restrict the folder that holds `envFilePath`, then reset an existing env
 * file to inherit only from it, which also drops any explicit ACE on the file.
 * Run it before the first secret is written into the folder.
 */
export function restrictEnvFileAccess(
  envFilePath: string,
  run: IcaclsRunner = runIcacls,
  exists: (filePath: string) => boolean = fs.existsSync,
): void {
  const dir = path.win32.dirname(envFilePath);
  try {
    run(restrictDirArgs(dir));
    if (exists(envFilePath)) run(resetFileArgs(envFilePath));
  } catch (err) {
    throw new Error(
      `could not restrict access to ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
