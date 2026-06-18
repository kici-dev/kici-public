import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvFileContent,
  parsePathFileContent,
  createEnvFiles,
  readEnvDelta,
  truncateEnvFiles,
  type EnvFiles,
} from './env-file.js';
import { applyEnvDelta } from './env-delta.js';

describe('parseEnvFileContent', () => {
  it('parses single-line KEY=value pairs', () => {
    expect(parseEnvFileContent('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('splits on the first = only (value may contain =)', () => {
    expect(parseEnvFileContent('URL=https://x?a=1&b=2')).toEqual({ URL: 'https://x?a=1&b=2' });
  });

  it('ignores blank lines and trims surrounding whitespace on the key', () => {
    expect(parseEnvFileContent('\n  FOO =bar\n\n  \nBAZ=qux\n')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('ignores garbage lines with no = sign', () => {
    expect(parseEnvFileContent('FOO=bar\nthis is not an assignment\nBAZ=qux')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('ignores lines with an empty key', () => {
    expect(parseEnvFileContent('=novalue\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('keeps an empty value (KEY=)', () => {
    expect(parseEnvFileContent('EMPTY=\nFOO=bar')).toEqual({ EMPTY: '', FOO: 'bar' });
  });

  it('last assignment to the same key wins', () => {
    expect(parseEnvFileContent('FOO=one\nFOO=two')).toEqual({ FOO: 'two' });
  });
});

describe('parsePathFileContent', () => {
  it('returns one trimmed directory per non-blank line in order', () => {
    expect(parsePathFileContent('/a\n  /b  \n\n/c\n')).toEqual(['/a', '/b', '/c']);
  });

  it('returns an empty array for empty content', () => {
    expect(parsePathFileContent('')).toEqual([]);
    expect(parsePathFileContent('\n  \n')).toEqual([]);
  });
});

describe('env-file lifecycle', () => {
  let dir: string;
  let files: EnvFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-envfile-test-'));
    files = await createEnvFiles(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates empty env + path files and exposes their paths', async () => {
    expect(files.envFile).toContain(dir);
    expect(files.pathFile).toContain(dir);
    expect(await readFile(files.envFile, 'utf8')).toBe('');
    expect(await readFile(files.pathFile, 'utf8')).toBe('');
  });

  it('readEnvDelta reads and parses both files into an EnvDelta', async () => {
    await writeFile(files.envFile, 'FOO=bar\nBAZ=qux\n');
    await writeFile(files.pathFile, '/opt/tool/bin\n');
    const delta = await readEnvDelta(files);
    expect(delta.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(delta.pathPrepends).toEqual(['/opt/tool/bin']);
  });

  it('readEnvDelta returns an empty delta when files are empty', async () => {
    const delta = await readEnvDelta(files);
    expect(delta.env).toEqual({});
    expect(delta.pathPrepends).toEqual([]);
  });

  it('truncateEnvFiles empties both files between steps', async () => {
    await writeFile(files.envFile, 'FOO=bar\n');
    await writeFile(files.pathFile, '/a\n');
    await truncateEnvFiles(files);
    expect(await readFile(files.envFile, 'utf8')).toBe('');
    expect(await readFile(files.pathFile, 'utf8')).toBe('');
    // A second step appending then reading sees only its own lines.
    await writeFile(files.envFile, 'SECOND=2\n', { flag: 'a' });
    const delta = await readEnvDelta(files);
    expect(delta.env).toEqual({ SECOND: '2' });
  });
});

describe('env-file + applyEnvDelta integration (the agent round trip)', () => {
  let dir2: string;
  let f2: EnvFiles;

  beforeEach(async () => {
    dir2 = await mkdtemp(join(tmpdir(), 'kici-envfile-rt-'));
    f2 = await createEnvFiles(dir2);
  });
  afterEach(async () => {
    await rm(dir2, { recursive: true, force: true });
  });

  it('reads a step-written file, applies the delta, rejects operator keys, truncates', async () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin', OP_SECRET: 'protected' };
    // Simulate a step's shell appending to $KICI_ENV / $KICI_PATH.
    await writeFile(f2.envFile, 'TOOL_VERSION=1.2.3\nOP_SECRET=attacker\n', { flag: 'a' });
    await writeFile(f2.pathFile, '/opt/tool/bin\n', { flag: 'a' });

    const delta = await readEnvDelta(f2);
    const rejected: string[] = [];
    const result = applyEnvDelta(delta, {
      operatorSecretKeys: new Set(['OP_SECRET']),
      target,
      onReject: (k) => rejected.push(k),
    });

    expect(target.TOOL_VERSION).toBe('1.2.3');
    expect(target.OP_SECRET).toBe('protected');
    expect(target.PATH).toBe('/opt/tool/bin:/usr/bin');
    expect(rejected).toEqual(['OP_SECRET']);
    expect(result.appliedKeys).toEqual(['TOOL_VERSION']);

    await truncateEnvFiles(f2);
    const empty = await readEnvDelta(f2);
    expect(empty.env).toEqual({});
    expect(empty.pathPrepends).toEqual([]);
  });
});
