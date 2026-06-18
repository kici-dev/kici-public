import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  manifestFilename,
  manifestPath,
  readKiciVersion,
  readManifest,
  resolveVersionFromLaunchSpec,
  writeManifest,
} from './manifest.js';
import type { InstanceManifest } from './types.js';

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    envFilePath: '/x/y/kici-test.env',
    configDir: '/x/y/',
    logDir: '/x/y/logs/',
    installBase: '/opt/kici/kici-test/',
    createdAt: '2026-05-28T00:00:00.000Z',
    kiciVersion: '0.1.13',
    ...overrides,
  };
}

describe('manifest', () => {
  it('manifestFilename is component-specific', () => {
    expect(manifestFilename('orchestrator')).toBe('.kici-orchestrator.json');
    expect(manifestFilename('agent')).toBe('.kici-agent.json');
  });

  it('manifestPath joins instanceDir + filename', () => {
    expect(manifestPath('/tmp/deploy', 'orchestrator')).toBe('/tmp/deploy/.kici-orchestrator.json');
  });

  it('writeManifest then readManifest round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-manifest-'));
    try {
      const m = makeManifest();
      const written = writeManifest(dir, m);
      expect(written).toBe(path.join(dir, '.kici-orchestrator.json'));
      const read = readManifest(dir, 'orchestrator');
      expect(read).toEqual(m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readManifest returns null when the file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-manifest-'));
    try {
      expect(readManifest(dir, 'orchestrator')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readManifest throws a clear error on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-manifest-'));
    try {
      fs.writeFileSync(path.join(dir, '.kici-orchestrator.json'), '{ not json');
      expect(() => readManifest(dir, 'orchestrator')).toThrow(/malformed.*manifest/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readManifest throws on schema mismatch (missing required field)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-manifest-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.kici-orchestrator.json'),
        JSON.stringify({ component: 'orchestrator' }),
      );
      expect(() => readManifest(dir, 'orchestrator')).toThrow(/invalid.*manifest/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readKiciVersion', () => {
  it('returns the orchestrator package version string', () => {
    const version = readKiciVersion();
    // Must be a real semver-shaped string, not 'unknown'.
    expect(version).not.toBe('unknown');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('resolveVersionFromLaunchSpec', () => {
  function mkPkg(component: 'orchestrator' | 'agent', version: string, entry: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-launchspec-'));
    const pkgDir = path.join(root, 'node_modules', '@kici-dev', component);
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@kici-dev/${component}`, version }),
    );
    const entryPath = path.join(pkgDir, 'dist', entry);
    fs.writeFileSync(entryPath, '// stub');
    return entryPath;
  }

  it('resolves the version from a server.js entry arg', () => {
    const entry = mkPkg('orchestrator', '1.2.3', 'server.js');
    const spec = { execPath: '/usr/bin/node', args: [entry] };
    expect(resolveVersionFromLaunchSpec(spec, 'orchestrator')).toBe('1.2.3');
  });

  it('resolves the version from a standalone.js entry arg', () => {
    const entry = mkPkg('orchestrator', '4.5.6', 'standalone.js');
    const spec = { execPath: '/usr/bin/node', args: [entry] };
    expect(resolveVersionFromLaunchSpec(spec, 'orchestrator')).toBe('4.5.6');
  });

  it('resolves the agent component', () => {
    const entry = mkPkg('agent', '7.8.9', 'server.js');
    const spec = { execPath: '/usr/bin/node', args: [entry] };
    expect(resolveVersionFromLaunchSpec(spec, 'agent')).toBe('7.8.9');
  });

  it('returns null for an opaque custom binary (no entry script)', () => {
    const spec = { execPath: '/opt/custom/kici-orchestrator-bin', args: [] };
    expect(resolveVersionFromLaunchSpec(spec, 'orchestrator')).toBeNull();
  });

  it('returns null when the entry belongs to a different component than requested', () => {
    const entry = mkPkg('agent', '1.0.0', 'server.js');
    const spec = { execPath: '/usr/bin/node', args: [entry] };
    // Requested orchestrator, but entry resolves to the agent package → mismatch.
    expect(resolveVersionFromLaunchSpec(spec, 'orchestrator')).toBeNull();
  });

  it('returns null when the package.json is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-launchspec-'));
    const entry = path.join(root, 'node_modules', '@kici-dev', 'orchestrator', 'dist', 'server.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// stub'); // no package.json written
    const spec = { execPath: '/usr/bin/node', args: [entry] };
    expect(resolveVersionFromLaunchSpec(spec, 'orchestrator')).toBeNull();
  });
});
