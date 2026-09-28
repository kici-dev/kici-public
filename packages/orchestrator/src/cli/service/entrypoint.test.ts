import { describe, it, expect } from 'vitest';
import {
  assertServerResolvable,
  resolveServerScript,
  selectServerEntry,
  resolveServiceExecutable,
} from './entrypoint.js';

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

describe('resolveServerScript', () => {
  it('turns the resolved module URL into a path', () => {
    expect(
      resolveServerScript(
        '@kici-dev/agent/server',
        'agent',
        () => 'file:///opt/kici/agent/dist/server.js',
      ),
    ).toBe('/opt/kici/agent/dist/server.js');
  });

  // fails-when: a kici-admin that cannot resolve the server (a standalone
  // package bundles no import.meta.resolve) crashes with a TypeError instead
  // of naming --binary.
  it('names --binary when this kici-admin cannot resolve modules at all', () => {
    expect(() => resolveServerScript('@kici-dev/agent/server', 'agent', undefined)).toThrow(
      /cannot find the agent server \(@kici-dev\/agent\/server\)[\s\S]*--binary/,
    );
  });

  it('names --binary and keeps the cause when the server is not installed', () => {
    const resolve = () => {
      throw new Error("Cannot find package '@kici-dev/orchestrator'");
    };
    expect(() =>
      resolveServerScript('@kici-dev/orchestrator/server', 'orchestrator', resolve),
    ).toThrow(/Cannot find package '@kici-dev\/orchestrator'[\s\S]*--binary/);
  });
});

describe('assertServerResolvable', () => {
  // fails-when: a standalone kici-admin runs the wizard and writes the env file
  // before it finds out it cannot locate the server.
  it('refuses up front when there is no --binary and no resolver', () => {
    expect(() => assertServerResolvable('agent', undefined, undefined)).toThrow(/--binary/);
  });

  // breaks-if-wrong: an npm-installed kici-admin, or any install with --binary, goes on.
  it('lets an install with --binary or a resolver go on', () => {
    expect(() =>
      assertServerResolvable('agent', '/opt/kici-agent/kici-agent', undefined),
    ).not.toThrow();
    expect(() =>
      assertServerResolvable('orchestrator', undefined, () => 'file:///x.js'),
    ).not.toThrow();
  });
});
