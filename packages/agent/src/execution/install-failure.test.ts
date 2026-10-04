import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachNpmDebugLog,
  describeInstallFailure,
  INSTALL_FAILURE_TAIL_CHARS,
  INSTALL_FAILURE_TAIL_LINES,
} from './install-failure.js';

/** An error shaped like the one a promisified `execFile` rejects with. */
function execFileError(fields: {
  stderr?: string;
  stdout?: string;
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
}): Error {
  const err = new Error(`Command failed: node npm-cli.js install\n${fields.stderr ?? ''}`);
  return Object.assign(err, {
    code: 'code' in fields ? fields.code : 1,
    signal: fields.signal ?? null,
    killed: fields.killed ?? false,
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
  });
}

describe('describeInstallFailure', () => {
  // fails-when: the description is the raw execFile message — with an empty
  // stderr it is the command line alone, and the exit code and stdout are lost.
  it('keeps the exit code and stdout when the installer wrote nothing to stderr', () => {
    const out = describeInstallFailure(
      execFileError({ code: 1, stdout: 'npm error code EBUSY\nnpm error busy' }),
      [],
    );
    expect(out.split('\n')).toEqual([
      'Command failed: node npm-cli.js install',
      'exit code 1',
      'stderr: (empty)',
      'stdout:',
      'npm error code EBUSY',
      'npm error busy',
    ]);
  });

  it('reports a signal and a timeout kill', () => {
    const out = describeInstallFailure(
      execFileError({ code: null, signal: 'SIGTERM', killed: true }),
      [],
    );
    expect(out).toContain('signal SIGTERM, killed (timeout or abort)');
    expect(out).not.toContain('exit code');
  });

  it('keeps the stderr the installer wrote', () => {
    const out = describeInstallFailure(
      execFileError({ stderr: 'npm error 404 Not Found - GET https://r/@x%2fy' }),
      [],
    );
    expect(out).toContain('stderr:\nnpm error 404 Not Found - GET https://r/@x%2fy');
    expect(out).toContain('stdout: (empty)');
  });

  it('redacts every registry token from the headline and both streams', () => {
    const token = 'npm_SECRETTOKEN123';
    const err = execFileError({ stderr: `401 for ${token}`, stdout: `auth ${token}` });
    err.message = `Command failed: npm install --//r/:_authToken=${token}\n401 for ${token}`;
    const out = describeInstallFailure(err, [token]);
    expect(out).not.toContain(token);
    expect(out).toContain('***REDACTED***');
  });

  it('keeps only the end of a long stream, marked as cut', () => {
    const lines = Array.from({ length: INSTALL_FAILURE_TAIL_LINES + 10 }, (_, i) => `line ${i}`);
    const out = describeInstallFailure(execFileError({ stdout: lines.join('\n') }), []);
    expect(out).toContain('stdout:\n[…]\nline 10\n');
    expect(out).toContain(`line ${INSTALL_FAILURE_TAIL_LINES + 9}`);
    expect(out).not.toContain('line 9\n');

    const wide = 'x'.repeat(INSTALL_FAILURE_TAIL_CHARS + 100);
    const outWide = describeInstallFailure(execFileError({ stderr: wide }), []);
    const section = outWide.slice(outWide.indexOf('stderr:\n') + 'stderr:\n'.length);
    expect(section.startsWith('[…]\n')).toBe(true);
    expect(section.split('\n')[1]).toHaveLength(INSTALL_FAILURE_TAIL_CHARS);
  });

  // breaks-if-wrong: an error that is not a finished subprocess keeps its own
  // message (a missing package manager, a spawn ENOENT without output).
  it('leaves an error without subprocess output as its message', () => {
    expect(describeInstallFailure(new Error('pnpm is not available'), [])).toBe(
      'pnpm is not available',
    );
    expect(describeInstallFailure('plain string', [])).toBe('plain string');
  });
});

describe('describeInstallFailure edge shapes', () => {
  // fails-when: a Node error code is printed as an exit status.
  it('labels a Node error code apart from an exit status', () => {
    const out = describeInstallFailure(execFileError({ code: 'ENOENT' }), []);
    expect(out).toContain('error code ENOENT');
    expect(out).not.toContain('exit code');
  });

  // fails-when: the cut check compares CRLF text against its LF rejoin.
  it('does not mark a short CRLF stream as cut', () => {
    const out = describeInstallFailure(execFileError({ stdout: 'a\r\nb\r\nc\r\n' }), []);
    expect(out).toContain('stdout:\na\nb\nc');
    expect(out).not.toContain('[…]');
  });

  // fails-when: a token is cut at the start of the kept window before it is
  // redacted, so its unmatched remainder survives.
  it('redacts a token that straddles the start of the kept window', () => {
    const token = 'npm_STRADDLE_0123456789abcdef';
    const filler = 'x'.repeat(INSTALL_FAILURE_TAIL_CHARS - 10);
    const out = describeInstallFailure(execFileError({ stdout: `${token}${filler}` }), [token]);
    // Cut before redaction would keep exactly the token's last 10 characters.
    expect(out).not.toContain(token.slice(-10));
  });

  it('handles a long whitespace run in linear time', () => {
    const start = Date.now();
    describeInstallFailure(execFileError({ stdout: `a${' '.repeat(200_000)}b` }), []);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('attachNpmDebugLog', () => {
  // fails-when: the npm debug log is not read before the cache is removed —
  // an install that wrote nothing to stderr then reports no cause.
  it('adds the end of the newest npm debug log to the description', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'kici-npm-cache-test-'));
    try {
      await mkdir(join(cache, '_logs'));
      await writeFile(join(cache, '_logs', '2026-10-03T09_00_00_000Z-debug-0.log'), 'old run\n');
      await writeFile(
        join(cache, '_logs', '2026-10-03T09_16_15_000Z-debug-0.log'),
        '0 verbose cli node npm-cli.js\n12 error code EPERM\n13 verbose exit 1\n',
      );
      const err = execFileError({ code: 1 });
      await attachNpmDebugLog(err, cache);
      const out = describeInstallFailure(err, []);
      expect(out).toContain('npm debug log:\n0 verbose cli node npm-cli.js\n12 error code EPERM');
      expect(out).not.toContain('old run');
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  // breaks-if-wrong: no debug log leaves the error and its description as they were.
  it('leaves the error alone when there is no debug log', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'kici-npm-cache-test-'));
    try {
      const err = execFileError({ code: 1 });
      await attachNpmDebugLog(err, cache);
      expect(describeInstallFailure(err, [])).not.toContain('npm debug log');
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
