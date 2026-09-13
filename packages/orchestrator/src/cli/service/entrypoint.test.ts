import { describe, it, expect } from 'vitest';
import { selectServerEntry, resolveServiceExecutable } from './entrypoint.js';

describe('selectServerEntry', () => {
  it('returns server for platform mode', () => {
    expect(selectServerEntry('KICI_MODE=platform\nKICI_PORT=4000\n')).toBe('server');
  });

  it('returns server for hybrid mode', () => {
    expect(selectServerEntry('KICI_MODE=hybrid\n')).toBe('server');
  });

  it('returns standalone for independent mode', () => {
    expect(selectServerEntry('KICI_MODE=independent\n')).toBe('standalone');
  });

  it('defaults to server when KICI_MODE is absent', () => {
    expect(selectServerEntry('KICI_PORT=4000\n')).toBe('server');
  });

  it('ignores a commented-out KICI_MODE line', () => {
    expect(selectServerEntry('# KICI_MODE=independent\nKICI_MODE=platform\n')).toBe('server');
  });
});

describe('resolveServiceExecutable', () => {
  it('runs node with the entry script when no binary is given', () => {
    expect(
      resolveServiceExecutable({ nodePath: '/usr/bin/node', entryScript: '/opt/k/dist/server.js' }),
    ).toEqual({ executablePath: '/usr/bin/node', args: ['/opt/k/dist/server.js'] });
  });

  it('runs an explicit binary directly with no args', () => {
    expect(
      resolveServiceExecutable({ binary: '/usr/local/bin/kici-orch', nodePath: '/usr/bin/node' }),
    ).toEqual({ executablePath: '/usr/local/bin/kici-orch', args: [] });
  });

  it('throws when neither binary nor entryScript is given', () => {
    expect(() => resolveServiceExecutable({ nodePath: '/usr/bin/node' })).toThrow();
  });
});
