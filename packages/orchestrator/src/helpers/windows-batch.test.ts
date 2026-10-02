import { describe, it, expect } from 'vitest';
import {
  BATCH_STDIN,
  BATCH_WRAPPER_ARGS,
  assertCmdSafe,
  batchFileCommand,
  cmdExePath,
  cmdSafetyRefusal,
  isBatchFile,
} from './windows-batch.js';

const USE = 'as a Windows service';
const REMEDY = 'Install from a path without it.';

describe('isBatchFile', () => {
  it.each(['C:\\a\\k.cmd', 'C:\\a\\K.CMD', 'C:\\a\\run.bat', 'C:\\a\\run.Bat'])(
    '%s is a batch file',
    (p) => expect(isBatchFile(p)).toBe(true),
  );
  it.each(['C:\\node\\node.exe', 'C:\\a\\kici-agent', 'C:\\Windows\\System32\\cmd.exe'])(
    '%s is not',
    (p) => expect(isBatchFile(p)).toBe(false),
  );
});

describe('cmdExePath', () => {
  it('uses a COMSPEC that names cmd.exe', () => {
    expect(cmdExePath({ COMSPEC: 'D:\\WINNT\\system32\\cmd.exe' })).toBe(
      'D:\\WINNT\\system32\\cmd.exe',
    );
  });
  it('ignores a COMSPEC that names another shell', () => {
    expect(cmdExePath({ COMSPEC: 'C:\\tcc\\tcc.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
  });
  it('falls back when COMSPEC is unset', () => {
    expect(cmdExePath({})).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

describe('cmdSafetyRefusal', () => {
  // fails-when: a character cmd.exe reads as syntax reaches it unquoted
  it.each([
    ['C:\\a&b\\kici.cmd', '&'],
    ['C:\\100%\\kici.cmd', '%'],
    ['C:\\x^y\\k.cmd', '^'],
    ['C:\\tools(1)\\k.cmd', '('],
    ['C:\\ci,prod\\k.cmd', ','],
    ['C:\\a;b\\k.cmd', ';'],
    ['C:\\a=b\\k.cmd', '='],
    ['C:\\a|b\\k.cmd', '|'],
    ['C:\\a<b\\k.cmd', '<'],
    ['C:\\a"b\\k.cmd', '"'],
    ['C:\\Program Files\\100%\\k.cmd', '%'],
    ['C:\\Program Files\\x^y\\k.cmd', '^'],
  ])('refuses %s', (token, char) => {
    expect(cmdSafetyRefusal(token, USE, REMEDY)).toBe(
      `cannot run "${token}" as a Windows service: it contains "${char}", which cmd.exe ` +
        `reads as syntax when it runs the batch file. Install from a path without it.`,
    );
  });

  // breaks-if-wrong: a quoted path (it holds a space) is refused for characters cmd.exe reads as text
  it.each(['C:\\Program Files (x86)\\A & B, C=D\\kici.cmd', 'C:\\kici\\service\\kici-agent.cmd'])(
    'accepts %s',
    (token) => {
      expect(cmdSafetyRefusal(token, USE, REMEDY)).toBeNull();
    },
  );

  it('assertCmdSafe throws the refusal', () => {
    expect(() => assertCmdSafe('C:\\a&b\\k.cmd', USE, REMEDY)).toThrow(
      'cannot run "C:\\a&b\\k.cmd" as a Windows service: it contains "&"',
    );
  });
});

describe('batchFileCommand', () => {
  it('runs the command through cmd.exe with stdin from NUL', () => {
    expect(batchFileCommand(['C:\\k\\run.cmd', '--flag'], {})).toEqual([
      'C:\\Windows\\System32\\cmd.exe',
      '/d',
      '/e:on',
      '/v:off',
      '/c',
      'call',
      'C:\\k\\run.cmd',
      '--flag',
      '<NUL',
    ]);
    expect(BATCH_WRAPPER_ARGS).toEqual(['/d', '/e:on', '/v:off', '/c', 'call']);
    expect(BATCH_STDIN).toBe('<NUL');
  });
});
