import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  manifestFilename,
  manifestPath,
  readKiciVersion,
  readManifest,
  resolveLauncherVersion,
  resolveNpmInstallTarget,
  resolveVersionFromLaunchSpec,
  writeInstallManifest,
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

describe('resolveNpmInstallTarget', () => {
  const NODE = '/home/u/.local/share/mise/installs/node/24.15.0/bin/node';
  const NM = '/home/u/.local/share/mise/installs/node/24.15.0/lib/node_modules';

  it('resolves kici-admin when orchestrator is nested under it', () => {
    const spec = {
      execPath: NODE,
      args: [`${NM}/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js`],
    };
    expect(resolveNpmInstallTarget(spec, 'orchestrator', { windows: false })).toEqual({
      nodeExecPath: NODE,
      npmPath: '/home/u/.local/share/mise/installs/node/24.15.0/bin/npm',
      owningPackage: 'kici-admin',
    });
  });

  it('resolves the standalone scoped package for a direct install', () => {
    const spec = { execPath: NODE, args: [`${NM}/@kici-dev/orchestrator/dist/server.js`] };
    expect(resolveNpmInstallTarget(spec, 'orchestrator', { windows: false })?.owningPackage).toBe(
      '@kici-dev/orchestrator',
    );
  });

  it('uses npm.cmd on windows', () => {
    const spec = {
      execPath: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\kici-admin\\node_modules\\@kici-dev\\agent\\dist\\server.js'],
    };
    expect(resolveNpmInstallTarget(spec, 'agent', { windows: true })).toEqual({
      nodeExecPath: 'C:\\node\\node.exe',
      npmPath: 'C:\\node\\npm.cmd',
      owningPackage: 'kici-admin',
    });
  });

  it('returns null for an opaque --binary install (no entry script)', () => {
    expect(
      resolveNpmInstallTarget({ execPath: '/opt/kici/orchestrator', args: [] }, 'orchestrator', {
        windows: false,
      }),
    ).toBeNull();
  });

  it('returns null for a non-node_modules (dev checkout) entry', () => {
    const spec = {
      execPath: NODE,
      args: ['/home/u/src/kici/packages/orchestrator/dist/server.js'],
    };
    // no @kici-dev/orchestrator/dist marker under node_modules → entry not found → null
    expect(resolveNpmInstallTarget(spec, 'orchestrator', { windows: false })).toBeNull();
  });
});

describe('resolveLauncherVersion', () => {
  let root: string;
  let base: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-launcher-version-'));
    base = path.join(root, 'kici-test') + path.sep;
    fs.mkdirSync(path.join(base, 'orchestrator-2.0.0'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'orchestrator-2.0.0', 'kici-orchestrator-standalone'),
      '#!/bin/sh\n',
    );
    fs.symlinkSync('orchestrator-2.0.0', path.join(base, 'orchestrator'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // fails-when: the resolver ignores the symlink an archive upgrade flips, so a
  // re-install through it records no version (or the CLI's).
  it('reads the version folder a launcher behind the component symlink resolves to', () => {
    const spec = {
      execPath: path.join(base, 'orchestrator', 'kici-orchestrator-standalone'),
      args: [],
    };
    expect(resolveLauncherVersion(spec, 'orchestrator', base)).toBe('2.0.0');
  });

  it('reads the version folder a launcher sits in directly (the Windows registration)', () => {
    const spec = {
      execPath: path.join(base, 'orchestrator-2.0.0', 'kici-orchestrator-standalone'),
      args: [],
    };
    expect(resolveLauncherVersion(spec, 'orchestrator', base)).toBe('2.0.0');
  });

  it('reads an npm entry script from its package', () => {
    const pkgDir = path.join(root, 'node_modules', '@kici-dev', 'orchestrator');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@kici-dev/orchestrator', version: '0.12.3' }),
    );
    fs.writeFileSync(path.join(pkgDir, 'dist', 'server.js'), '// stub');
    const spec = { execPath: '/usr/bin/node', args: [path.join(pkgDir, 'dist', 'server.js')] };
    expect(resolveLauncherVersion(spec, 'orchestrator', base)).toBe('0.12.3');
  });

  // breaks-if-wrong: a launcher that shows no version must yield null, never a guess.
  // fails-when: the resolver matches a `<component>-<version>` folder anywhere in
  // the path, not only the first folder under the install base.
  it('returns null for a launcher in a version folder outside the install base', () => {
    const outside = path.join(root, 'orchestrator-9.9.9');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'kici-orchestrator-standalone'), '#!/bin/sh\n');
    const spec = { execPath: path.join(outside, 'kici-orchestrator-standalone'), args: [] };
    expect(resolveLauncherVersion(spec, 'orchestrator', base)).toBeNull();
  });

  // fails-when: a relative token is resolved against the working directory of
  // the CLI, which says nothing about where the service starts.
  it('returns null for a relative launcher path', () => {
    const saved = process.cwd();
    process.chdir(path.join(base, 'orchestrator-2.0.0'));
    try {
      const spec = { execPath: 'kici-orchestrator-standalone', args: [] };
      expect(resolveLauncherVersion(spec, 'orchestrator', base)).toBeNull();
    } finally {
      process.chdir(saved);
    }
  });

  it('returns null for the install base folder itself', () => {
    expect(resolveLauncherVersion({ execPath: base, args: [] }, 'orchestrator', base)).toBeNull();
  });

  it("returns null for another component's version folder", () => {
    const spec = {
      execPath: path.join(base, 'orchestrator', 'kici-orchestrator-standalone'),
      args: [],
    };
    expect(resolveLauncherVersion(spec, 'agent', base)).toBeNull();
  });

  it('returns null when the install base does not exist', () => {
    const spec = {
      execPath: path.join(base, 'orchestrator', 'kici-orchestrator-standalone'),
      args: [],
    };
    expect(
      resolveLauncherVersion(spec, 'orchestrator', path.join(root, 'missing') + path.sep),
    ).toBeNull();
  });
});

describe('writeInstallManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-install-manifest-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const opaque = { execPath: '/opt/custom/kici-orchestrator-bin', args: [] };

  // breaks-if-wrong: a first install must write exactly what install built.
  it('writes a first install as install built it', () => {
    const fresh = makeManifest({ kiciVersion: '0.12.0' });
    const res = writeInstallManifest(dir, fresh, opaque);
    expect(res.warning).toBeUndefined();
    expect(res.file).toBe(manifestPath(dir, 'orchestrator'));
    expect(readManifest(dir, 'orchestrator')).toEqual(fresh);
  });

  // fails-when: a re-install writes install's fresh manifest over the one there,
  // dropping the heads the rollback schema guard reads.
  it('keeps what the instance recorded and takes what install derives', () => {
    writeManifest(
      dir,
      makeManifest({
        platform: 'launchd',
        logDir: '/old/logs/',
        createdAt: '2026-01-01T00:00:00.000Z',
        kiciVersion: '0.11.0',
        migrationHeads: { '0.10.0': '040_a', '0.11.0': '045_b' },
      }),
    );
    const fresh = makeManifest({ createdAt: '2026-09-27T00:00:00.000Z', kiciVersion: '0.12.0' });
    const res = writeInstallManifest(dir, fresh, opaque);
    expect(res.warning).toBeUndefined();
    expect(res.manifest).toEqual({
      ...fresh,
      createdAt: '2026-01-01T00:00:00.000Z',
      // The launcher shows no version, so the recorded one stands — not the CLI's.
      kiciVersion: '0.11.0',
      migrationHeads: { '0.10.0': '040_a', '0.11.0': '045_b' },
    });
    expect(readManifest(dir, 'orchestrator')).toEqual(res.manifest);
  });

  it('records the version of a launcher under the install base', () => {
    const base = path.join(dir, 'base') + path.sep;
    fs.mkdirSync(path.join(base, 'orchestrator-2.0.0'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'orchestrator-2.0.0', 'kici-orchestrator-standalone'),
      '#!/bin/sh\n',
    );
    fs.symlinkSync('orchestrator-2.0.0', path.join(base, 'orchestrator'));
    writeManifest(dir, makeManifest({ installBase: base, kiciVersion: '1.0.0' }));
    const res = writeInstallManifest(
      dir,
      makeManifest({ installBase: base, kiciVersion: '0.12.0' }),
      { execPath: path.join(base, 'orchestrator', 'kici-orchestrator-standalone'), args: [] },
    );
    expect(res.manifest.kiciVersion).toBe('2.0.0');
  });

  function digestRecord(rec: unknown): string {
    const file = path.join(dir, 'installer-image-digests.json');
    fs.writeFileSync(file, JSON.stringify(rec));
    return file;
  }

  // fails-when: a compose re-install keeps the recorded version, or takes the
  // version of the CLI. The compose file pins the image release its digest
  // record names, whatever --binary names.
  it('records the release a compose re-install pins', () => {
    writeManifest(
      dir,
      makeManifest({ platform: 'compose', kiciVersion: '0.12.0', migrationHeads: { a: 'b' } }),
    );
    const digestRecordPath = digestRecord({
      version: '0.13.0',
      images: { 'kici-orchestrator': 'sha256:' + 'a'.repeat(64) },
    });
    const res = writeInstallManifest(
      dir,
      makeManifest({ platform: 'compose', kiciVersion: '0.99.0' }),
      opaque,
      { digestRecordPath },
    );
    expect(res.manifest.kiciVersion).toBe('0.13.0');
    expect(res.manifest.migrationHeads).toEqual({ a: 'b' });
  });

  // breaks-if-wrong: a compose file that falls back to :latest pins no release,
  // so the recorded version stands.
  it('keeps the recorded version when the compose file pins :latest', () => {
    writeManifest(dir, makeManifest({ platform: 'compose', kiciVersion: '0.12.0' }));
    const digestRecordPath = digestRecord({ version: '0.13.0', images: {} });
    const res = writeInstallManifest(
      dir,
      makeManifest({ platform: 'compose', kiciVersion: '0.99.0' }),
      opaque,
      { digestRecordPath },
    );
    expect(res.manifest.kiciVersion).toBe('0.12.0');
  });

  it('keeps a field a newer CLI wrote', () => {
    writeManifest(dir, { ...makeManifest(), futureField: { kept: true } } as InstanceManifest);
    const res = writeInstallManifest(dir, makeManifest(), opaque);
    expect((res.manifest as unknown as Record<string, unknown>).futureField).toEqual({
      kept: true,
    });
  });

  it('replaces the manifest of another instance, and says so', () => {
    writeManifest(dir, makeManifest({ name: 'kici-other', migrationHeads: { '0.11.0': '045_b' } }));
    const fresh = makeManifest({ kiciVersion: '0.12.0' });
    const res = writeInstallManifest(dir, fresh, opaque);
    expect(res.manifest).toEqual(fresh);
    expect(readManifest(dir, 'orchestrator')).toEqual(fresh);
    expect(res.warning).toContain('"kici-other"');
    expect(res.warning).toContain('"kici-test"');
  });

  it('replaces a manifest it cannot read, and says so', () => {
    fs.writeFileSync(manifestPath(dir, 'orchestrator'), '{ not json');
    const fresh = makeManifest();
    const res = writeInstallManifest(dir, fresh, opaque);
    expect(res.manifest).toEqual(fresh);
    expect(readManifest(dir, 'orchestrator')).toEqual(fresh);
    expect(res.warning).toMatch(/malformed instance manifest/i);
    expect(res.warning).toContain('migration heads');
  });
});
