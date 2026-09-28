import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATORS_SID,
  LOCAL_SYSTEM_SID,
  resetFileArgs,
  restrictDirArgs,
  restrictEnvFileAccess,
} from './windows-acl.js';

const DIR = 'C:\\ProgramData\\kici\\o';
const ENV_FILE = `${DIR}\\o.env`;

describe('restrictDirArgs', () => {
  // fails-when: inheritance from C:\ProgramData stays on (BUILTIN\Users keeps
  // read), or the grants do not reach the files created in the folder.
  it('replaces the folder ACL with inherited full control for LocalSystem and Administrators', () => {
    expect(restrictDirArgs(DIR)).toEqual([
      DIR,
      '/inheritance:r',
      '/grant:r',
      `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`,
      `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
      '/L',
      '/Q',
    ]);
    expect(LOCAL_SYSTEM_SID).toBe('S-1-5-18');
    expect(ADMINISTRATORS_SID).toBe('S-1-5-32-544');
  });
});

describe('restrictEnvFileAccess', () => {
  it('restricts the folder, then resets an existing env file to inherit from it', () => {
    const calls: string[][] = [];
    restrictEnvFileAccess(
      ENV_FILE,
      (args) => calls.push(args),
      (p) => p === ENV_FILE,
    );
    expect(calls).toEqual([restrictDirArgs(DIR), resetFileArgs(ENV_FILE)]);
  });

  // breaks-if-wrong: a fresh install restricts the folder before the env file exists.
  it('restricts only the folder when the env file does not exist yet', () => {
    const calls: string[][] = [];
    restrictEnvFileAccess(
      ENV_FILE,
      (args) => calls.push(args),
      () => false,
    );
    expect(calls).toEqual([restrictDirArgs(DIR)]);
  });

  // fails-when: a call recurses (a recursive reset descends into the target of
  // a junction planted in the folder and grants BUILTIN\Users read on a
  // protected file there, measured on Windows 11) or follows a symbolic link.
  it('acts on the folder and the env file themselves, never recursively or through a link', () => {
    const calls: string[][] = [];
    restrictEnvFileAccess(
      ENV_FILE,
      (args) => calls.push(args),
      () => true,
    );
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args).toContain('/L');
      expect(args).not.toContain('/T');
    }
  });

  it('names the folder when icacls fails', () => {
    expect(() =>
      restrictEnvFileAccess(
        ENV_FILE,
        () => {
          throw new Error('Access is denied.');
        },
        () => false,
      ),
    ).toThrow(/could not restrict access to C:\\ProgramData\\kici\\o: Access is denied/);
  });
});
