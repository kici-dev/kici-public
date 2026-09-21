import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform-detect to control isRoot() in tests.
vi.mock('./platform-detect.js', () => ({
  isRoot: vi.fn(() => false),
}));

import { isRoot } from './platform-detect.js';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUserLevel, systemRerunHint } from './privilege.js';

const mockedIsRoot = isRoot as ReturnType<typeof vi.fn>;

describe('resolveUserLevel', () => {
  beforeEach(() => {
    mockedIsRoot.mockReset();
  });

  it('auto-detects user-level when running as non-root + no flags', () => {
    mockedIsRoot.mockReturnValue(false);
    expect(resolveUserLevel({})).toBe(true);
  });

  it('auto-detects system-level when running as root + no flags', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({})).toBe(false);
  });

  it('honors --user-level even when running as root', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({ userLevel: true })).toBe(true);
  });

  it('honors --system when running as root', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(resolveUserLevel({ system: true })).toBe(false);
  });

  it('throws when --system is passed but the process is non-root', () => {
    mockedIsRoot.mockReturnValue(false);
    expect(() => resolveUserLevel({ system: true })).toThrow(/requires root/i);
    // fails-when: resolveUserLevel still throws the literal `sudo kici-admin …` hint
    // instead of the command built from the running process.
    expect(() => resolveUserLevel({ system: true })).toThrow(process.execPath);
    expect(() => resolveUserLevel({ system: true })).toThrow(realpathSync(process.argv[1] ?? ''));
    expect(() => resolveUserLevel({ system: true })).not.toThrow(/sudo kici-admin/);
  });

  it('throws when both --system and --user-level are passed', () => {
    mockedIsRoot.mockReturnValue(true);
    expect(() => resolveUserLevel({ system: true, userLevel: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});

describe('systemRerunHint', () => {
  it('names the resolved node binary, the resolved script, and every argument', () => {
    const hint = systemRerunHint({
      execPath: '/home/op/.local/share/mise/installs/node/24.1.0/bin/node',
      argv: ['node', process.argv[1] ?? '', 'orchestrator', 'stop', '--system', '--name', 'stg-b'],
      platform: 'linux',
    });
    // fails-when: the literal `sudo kici-admin orchestrator install` comes back, or an
    // argument is dropped, or the bare `node` from argv[0] is printed instead of execPath.
    expect(hint).toContain(
      'sudo /home/op/.local/share/mise/installs/node/24.1.0/bin/node ' +
        `${realpathSync(process.argv[1] ?? '')} orchestrator stop --system --name stg-b`,
    );
    expect(hint).not.toContain('sudo kici-admin');
    expect(hint).toContain('version manager');
  });

  it('single-quotes an argument that carries a shell metacharacter', () => {
    const hint = systemRerunHint({
      execPath: '/usr/bin/node',
      argv: [
        'node',
        '/opt/kici admin/cli.js',
        'orchestrator',
        'install',
        '--system',
        '--name',
        "it's",
      ],
      platform: 'linux',
    });
    // fails-when: the space in the script path or the quote in the name reaches the
    // shell unquoted, so the printed command would split or not parse.
    expect(hint).toContain(
      "'/opt/kici admin/cli.js' orchestrator install --system --name 'it'\\''s'",
    );
  });

  it('prints the file behind a symlinked entry point, not the symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-privilege-'));
    try {
      const real = join(dir, 'cli.js');
      const link = join(dir, 'kici-admin');
      writeFileSync(real, '');
      symlinkSync(real, link);
      const hint = systemRerunHint({
        execPath: '/usr/bin/node',
        argv: ['node', link, 'orchestrator', 'install', '--system'],
        platform: 'linux',
      });
      // fails-when: canonicalScript stops following symlinks and prints the
      // `node_modules/.bin` / shim path a version manager put on argv[1].
      expect(hint).toContain(
        `sudo /usr/bin/node ${realpathSync(real)} orchestrator install --system`,
      );
      expect(hint).not.toContain(link);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the script when argv has no entry point', () => {
    const hint = systemRerunHint({ execPath: '/usr/bin/node', argv: ['node'], platform: 'linux' });
    expect(hint).toContain('sudo /usr/bin/node\n');
  });

  it('names an elevated shell instead of sudo on Windows', () => {
    const hint = systemRerunHint({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['node', 'C:\\cli.js', 'orchestrator', 'install', '--system'],
      platform: 'win32',
    });
    // fails-when: a `sudo` line is printed on a platform that has no sudo.
    expect(hint).not.toContain('sudo');
    expect(hint).toMatch(/administrator/i);
  });
});
