import { describe, it, expect } from 'vitest';
import { selectMiseTemplate } from './templates.js';

describe('selectMiseTemplate', () => {
  it('returns the bash template + posix cache path for linux', () => {
    const t = selectMiseTemplate('linux');
    expect(t.shell).toBe('bash');
    expect(t.cachePaths).toEqual(['~/.local/share/mise']);
    expect(t.run).toContain('curl -fsSL https://mise.run | sh');
    expect(t.run).toContain('mise trust');
    expect(t.run).toContain('mise env -s bash');
    expect(t.run).toContain('"$KICI_ENV"');
    expect(t.run).toContain('"$KICI_PATH"');
  });

  it('returns the bash template for darwin', () => {
    expect(selectMiseTemplate('darwin').shell).toBe('bash');
  });

  it('returns the pwsh template + Windows cache path for win32', () => {
    const t = selectMiseTemplate('win32');
    expect(t.shell).toBe('pwsh');
    expect(t.cachePaths).toEqual(['~/AppData/Local/mise']);
    // mise calls go through the Invoke-Mise wrapper so a successful command
    // that writes to stderr doesn't trip $ErrorActionPreference = 'Stop'.
    expect(t.run).toContain('function Invoke-Mise');
    expect(t.run).toContain("$ErrorActionPreference = 'Continue'");
    expect(t.run).toContain('if ($code -ne 0)');
    expect(t.run).toContain('Invoke-Mise trust');
    expect(t.run).toContain('Invoke-Mise install');
    expect(t.run).toContain('Invoke-Mise env -s pwsh');
    expect(t.run).toContain('Invoke-Mise bin-paths');
    expect(t.run).toContain('$env:KICI_ENV');
    expect(t.run).toContain('$env:KICI_PATH');
    expect(t.run).toContain('Expand-Archive');
  });

  it('throws for an unsupported platform', () => {
    expect(() => selectMiseTemplate('aix' as never)).toThrow(/unsupported/i);
  });
});

describe('selectMiseTemplate env handoff', () => {
  it('pwsh un-doubles the quote PowerShell doubles inside a single-quoted value', () => {
    // fails-when: a value such as it''s reaches steps with the doubled quote kept
    expect(selectMiseTemplate('win32').run).toContain(`$Matches[2] -replace "''", "'"`);
  });
});

describe('selectMiseTemplate with a pin', () => {
  it('bash: installs into the KiCI-owned dir with MISE_VERSION and checks the version', () => {
    const t = selectMiseTemplate('linux', '2026.5.1');
    expect(t.run).toContain("kici_mise_want='2026.5.1'");
    expect(t.run).toContain('MISE_VERSION="v$kici_mise_want"');
    expect(t.run).toContain('mise version mismatch');
    // fails-when: the pinned path still trusts any mise already on PATH
    expect(t.run).not.toContain('command -v mise');
    const pinnedLine = t.run.indexOf('echo "$kici_mise_dir" >> "$KICI_PATH"');
    const shimsLine = t.run.indexOf('/.local/share/mise/shims" >> "$KICI_PATH"');
    expect(pinnedLine).toBeGreaterThan(-1);
    expect(pinnedLine).toBeLessThan(shimsLine);
  });

  it('pwsh: pins the dir, checks the version, and adds the pinned bin before bin-paths', () => {
    const t = selectMiseTemplate('win32', '2026.5.1');
    expect(t.run).toContain("$kiciMiseWant = '2026.5.1'");
    expect(t.run).toContain('throw "mise version mismatch');
    expect(t.run).not.toContain('if (-not (Get-Command mise -ErrorAction SilentlyContinue))');
    expect(t.run.indexOf('-Value $kiciMiseBin')).toBeLessThan(
      t.run.indexOf('Invoke-Mise bin-paths'),
    );
  });

  it('refuses a version that is not a bare release', () => {
    // fails-when: an unvalidated value is substituted into the install script
    expect(() => selectMiseTemplate('linux', "2026.5.1'; curl evil")).toThrow(
      /invalid mise version/,
    );
    expect(() => selectMiseTemplate('linux', 'v2026.5.1')).toThrow(/invalid mise version/);
  });

  it('unpinned templates carry no pin', () => {
    // breaks-if-wrong: the refactor leaks pinned pieces into the default preset
    expect(selectMiseTemplate('linux').run).not.toMatch(/kici_mise_(want|dir|version)/);
    expect(selectMiseTemplate('win32').run).not.toContain('kiciMise');
  });
});
