/**
 * Restrict a Windows service's env file to LocalSystem and Administrators.
 *
 * On Windows a Node file mode only toggles the read-only attribute, so
 * ENV_FILE_MODE protects nothing, and the instance folder under
 * C:\ProgramData\kici\ inherits BUILTIN\Users read. The folder ACL becomes
 * inherited full control for LocalSystem (the shawl service account) and
 * Administrators, so the env file, a secure write's temp file and the logs are
 * private from the moment they exist.
 *
 * Every call passes `/L` and none recurses: a recursive `/reset` or
 * `/setowner` follows a junction or symlink even with `/L` and rewrites the
 * ACLs at its target. The folder ACL still reaches every inheriting entry.
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
 * The icacls beside COMSPEC's cmd.exe: a bare `icacls` is also looked up in
 * the current folder, and the install runs elevated.
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
 * Drop every inherited ACE from `dir` and grant inherited full control to
 * LocalSystem and Administrators, by SID so a localized Windows resolves them.
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
 * Restrict the env file's folder, then reset an existing env file to inherit
 * only from it (dropping any explicit ACE). Run before the first secret is written.
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
