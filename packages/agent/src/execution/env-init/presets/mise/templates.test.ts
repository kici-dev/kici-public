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
