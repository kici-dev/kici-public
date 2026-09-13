import { describe, it, expect } from 'vitest';
import { hasEnvAssignment, upsertEnvAssignment } from './env-assignment.js';
import { selectServerEntry } from './entrypoint.js';

describe('hasEnvAssignment', () => {
  it('finds an uncommented assignment, with or without surrounding space', () => {
    expect(hasEnvAssignment('KICI_MODE=hybrid\n', 'KICI_MODE')).toBe(true);
    expect(hasEnvAssignment('  KICI_MODE = hybrid\n', 'KICI_MODE')).toBe(true);
  });

  it('does not count a commented mention', () => {
    // The same rule selectServerEntry applies: a `#` line is documentation,
    // and neither systemd nor the installer reads a value out of one.
    expect(hasEnvAssignment('#   KICI_MODE=hybrid\n', 'KICI_MODE')).toBe(false);
    expect(hasEnvAssignment('# KICI_MODE=hybrid\nKICI_PORT=4000\n', 'KICI_MODE')).toBe(false);
  });
});

describe('upsertEnvAssignment', () => {
  it('appends when the variable is declared nowhere', () => {
    expect(upsertEnvAssignment('KICI_PORT=4000\n', 'KICI_MODE', 'independent')).toBe(
      'KICI_PORT=4000\nKICI_MODE=independent\n',
    );
  });

  it('replaces in place, keeping the comment above it attached', () => {
    expect(
      upsertEnvAssignment(
        '# the mode\nKICI_MODE=hybrid\nKICI_PORT=4000\n',
        'KICI_MODE',
        'observed',
      ),
    ).toBe('# the mode\nKICI_MODE=observed\nKICI_PORT=4000\n');
  });

  it('leaves a commented mention alone and appends a real assignment', () => {
    const out = upsertEnvAssignment('#   KICI_MODE=hybrid\n', 'KICI_MODE', 'independent');
    expect(out).toBe('#   KICI_MODE=hybrid\nKICI_MODE=independent\n');
    // fails-when: the append lands inside the comment, or after a blank run
    //   that leaves the file's last line empty — either way the entry-point
    //   selector reads no mode and the install bakes the wrong server.
    expect(selectServerEntry(out)).toBe('standalone');
  });

  it('appends flush against trailing blank lines', () => {
    expect(upsertEnvAssignment('KICI_PORT=4000\n\n\n', 'KICI_MODE', 'platform')).toBe(
      'KICI_PORT=4000\nKICI_MODE=platform\n',
    );
  });

  it('rewrites every duplicate, so the last-wins reader sees the new value', () => {
    expect(
      upsertEnvAssignment('KICI_MODE=hybrid\nKICI_MODE=platform\n', 'KICI_MODE', 'independent'),
    ).toBe('KICI_MODE=independent\nKICI_MODE=independent\n');
  });

  it('appends to empty content without a leading blank line', () => {
    expect(upsertEnvAssignment('', 'KICI_MODE', 'hybrid')).toBe('KICI_MODE=hybrid\n');
  });
});
