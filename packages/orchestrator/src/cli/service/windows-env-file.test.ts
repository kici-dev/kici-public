/**
 * Tests for the check that a Windows service launch runs a release that reads
 * KICI_ENV_FILE. Real files in a temporary folder: the check reads the bundle
 * beside a KiCI package launcher and the entry of an npm install.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFileRefusal, launchReadsEnvFile } from './windows-env-file.js';

/** A bundle of a release that reads KICI_ENV_FILE. */
const READS_BUNDLE = 'const SERVICE_ENV_FILE_VAR = "KICI_ENV_FILE";';
/** The entry of an npm release that reads KICI_ENV_FILE. */
const READS_ENTRY = 'import "@kici-dev/shared/load-service-env-file";\nimport "./app.js";';
/** A bundle or entry of a release from before KICI_ENV_FILE. */
const PREDATES = 'import "./app.js"; // no env-file loader';

describe('launchReadsEnvFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-file-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A KiCI package: `<dir>/<name>.cmd` beside `<dir>/lib/<name>.cjs`. */
  function packageLauncher(bundle: string | null): string {
    const launcher = path.join(tmp, 'kici-orchestrator-standalone.cmd');
    fs.writeFileSync(launcher, '@echo off\r\n');
    if (bundle !== null) {
      fs.mkdirSync(path.join(tmp, 'lib'));
      fs.writeFileSync(path.join(tmp, 'lib', 'kici-orchestrator-standalone.cjs'), bundle);
    }
    return launcher;
  }

  /** An npm install's agent entry, as `install` registers it. */
  function npmEntry(content: string | null): string {
    const dist = path.join(
      tmp,
      'node_modules',
      'kici-admin',
      'node_modules',
      '@kici-dev',
      'agent',
      'dist',
    );
    fs.mkdirSync(dist, { recursive: true });
    const entry = path.join(dist, 'server.js');
    if (content !== null) fs.writeFileSync(entry, content);
    return entry;
  }

  // fails-when: a package launcher whose bundle predates KICI_ENV_FILE is
  // taken to read it, so a switch to that release is accepted.
  it('is false for a package launcher whose bundle does not name KICI_ENV_FILE', () => {
    expect(launchReadsEnvFile({ executablePath: packageLauncher(PREDATES) })).toBe(false);
  });

  // breaks-if-wrong: the launcher of a release that reads KICI_ENV_FILE passes.
  it('is true for a package launcher whose bundle names KICI_ENV_FILE', () => {
    expect(launchReadsEnvFile({ executablePath: packageLauncher(READS_BUNDLE) })).toBe(true);
  });

  // fails-when: the bundle check accepts the name of the loader module, which
  // an unminified bundle carries in a comment even when the variable it reads
  // is not KICI_ENV_FILE.
  it('is false for a package launcher whose bundle names only the loader module', () => {
    const bundle =
      '//#region packages/shared/dist/load-service-env-file.js\nread("KICI_ENV_FILX");';
    expect(launchReadsEnvFile({ executablePath: packageLauncher(bundle) })).toBe(false);
  });

  it('is true for a batch file with no KiCI bundle beside it', () => {
    expect(launchReadsEnvFile({ executablePath: packageLauncher(null) })).toBe(true);
  });

  // fails-when: an npm entry that predates KICI_ENV_FILE is taken to read it,
  // so an npm-source downgrade to that release is accepted.
  it('is false for an npm entry that does not import the env-file loader', () => {
    const launch = { executablePath: '/n/node', args: [npmEntry(PREDATES)] };
    expect(launchReadsEnvFile(launch)).toBe(false);
  });

  // fails-when: the entry check accepts the variable name, which a pre-release
  // entry never imports the loader for.
  it('is false for an npm entry that names KICI_ENV_FILE without importing the loader', () => {
    const launch = { executablePath: '/n/node', args: [npmEntry('// reads KICI_ENV_FILE')] };
    expect(launchReadsEnvFile(launch)).toBe(false);
  });

  // breaks-if-wrong: the npm entry of a release that reads KICI_ENV_FILE passes.
  it('is true for an npm entry that imports the env-file loader', () => {
    const launch = { executablePath: '/n/node', args: [npmEntry(READS_ENTRY)] };
    expect(launchReadsEnvFile(launch)).toBe(true);
  });

  it('is true for an npm entry that cannot be read', () => {
    const launch = { executablePath: '/n/node', args: [npmEntry(null)] };
    expect(launchReadsEnvFile(launch)).toBe(true);
  });

  it('is true for an executable that is neither a batch file nor a KiCI entry', () => {
    const script = path.join(tmp, 'custom.js');
    fs.writeFileSync(script, PREDATES);
    expect(launchReadsEnvFile({ executablePath: '/n/node', args: [script] })).toBe(true);
    expect(launchReadsEnvFile({ executablePath: path.join(tmp, 'kici.exe') })).toBe(true);
  });
});

describe('envFileRefusal', () => {
  it('names the release, the env file and both ways forward', () => {
    const msg = envFileRefusal('kici-admin@0.11.0', 'C:\\ProgramData\\kici\\a\\a.env');
    expect(msg).toContain('kici-admin@0.11.0 predates KICI_ENV_FILE');
    expect(msg).toContain('C:\\ProgramData\\kici\\a\\a.env on its command line');
    expect(msg).toContain('Use a release that reads KICI_ENV_FILE');
    expect(msg).toContain('install it with the kici-admin of that release');
  });
});
