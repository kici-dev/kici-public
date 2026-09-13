import { describe, it, expect } from 'vitest';
import { primaryHostOsLabel, rewriteRunsOnForHost, shouldOfferFirstRun } from './init-host-os.js';

describe('primaryHostOsLabel', () => {
  it('maps linux to kici:os:linux', () => {
    expect(primaryHostOsLabel('linux', 'x64')).toBe('kici:os:linux');
  });
  it('maps darwin to kici:os:macos (first os label, not darwin)', () => {
    expect(primaryHostOsLabel('darwin', 'arm64')).toBe('kici:os:macos');
  });
  it('maps win32 to kici:os:windows', () => {
    expect(primaryHostOsLabel('win32', 'x64')).toBe('kici:os:windows');
  });
  it('falls back to kici:os:<platform> for an unknown platform', () => {
    expect(primaryHostOsLabel('freebsd', 'x64')).toBe('kici:os:freebsd');
  });
});

describe('rewriteRunsOnForHost', () => {
  const tpl = `job('greet', {\n      runsOn: 'kici:os:linux',\n`;
  it('is a no-op on a linux host', () => {
    expect(rewriteRunsOnForHost(tpl, 'linux', 'x64')).toBe(tpl);
  });
  it('rewrites every occurrence to the macOS label on a darwin host', () => {
    const two = tpl + `runsOn: 'kici:os:linux',`;
    const out = rewriteRunsOnForHost(two, 'darwin', 'arm64');
    expect(out).toContain(`runsOn: 'kici:os:macos'`);
    expect(out).not.toContain('kici:os:linux');
  });
  it('rewrites to the windows label on a win32 host', () => {
    expect(rewriteRunsOnForHost(tpl, 'win32', 'x64')).toContain(`runsOn: 'kici:os:windows'`);
  });
});

describe('shouldOfferFirstRun', () => {
  it('offers when TTY, not CI, deps installed', () => {
    expect(shouldOfferFirstRun({ isTTY: true, ci: false, mjs: false, skipInstall: false })).toBe(
      true,
    );
  });
  it('skips in CI', () => {
    expect(shouldOfferFirstRun({ isTTY: true, ci: true, mjs: false, skipInstall: false })).toBe(
      false,
    );
  });
  it('skips when not a TTY', () => {
    expect(shouldOfferFirstRun({ isTTY: false, ci: false, mjs: false, skipInstall: false })).toBe(
      false,
    );
  });
  it('skips in mjs mode (no deps installed)', () => {
    expect(shouldOfferFirstRun({ isTTY: true, ci: false, mjs: true, skipInstall: false })).toBe(
      false,
    );
  });
  it('skips when install was skipped', () => {
    expect(shouldOfferFirstRun({ isTTY: true, ci: false, mjs: false, skipInstall: true })).toBe(
      false,
    );
  });
});
