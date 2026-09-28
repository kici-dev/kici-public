import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  readEnvContent,
  buildInfoRows,
  formatHealthSection,
  hideBuildCommit,
  localUrl,
  readLocalEndpoint,
} from './service-health.js';

describe('buildInfoRows', () => {
  it('renders only the fields an older service reports', () => {
    // fails-when: a missing field renders as "undefined" or an empty value —
    // an orchestrator older than this CLI reports fewer build fields.
    expect(buildInfoRows({ uptime: 59.9 })).toEqual([['Uptime', '59s']]);
    expect(buildInfoRows({ version: '0.9.0' })).toEqual([['Version', '0.9.0']]);
    expect(buildInfoRows({ sdkVersion: '0.9.0' })).toEqual([['SDK', '0.9.0']]);
  });

  it('adds the build date to the version, and never the build commit an older service reports', () => {
    // fails-when: the renderer prints buildCommit — a service older than this
    // CLI reports the private repository's commit ID there.
    expect(
      buildInfoRows({
        version: '1.2.3',
        buildCommit: 'abc1234',
        buildDate: '2026-09-26T00:00:00Z',
      }),
    ).toEqual([['Version', '1.2.3 (built 2026-09-26T00:00:00Z)']]);
  });
});

describe('hideBuildCommit', () => {
  it('replaces the build commit an older service reports with its version', () => {
    // fails-when: --json passes an older service's build commit through.
    expect(hideBuildCommit({ version: '0.11.0', buildCommit: '3e5f7a9c1', uptime: 5 })).toEqual({
      version: '0.11.0',
      buildCommit: '0.11.0',
      uptime: 5,
    });
  });

  it('keeps the key a string when the body reports no version', () => {
    expect(hideBuildCommit({ buildCommit: '3e5f7a9c1' })).toEqual({ buildCommit: 'unknown' });
  });

  it('adds no key to a body that reports none', () => {
    // breaks-if-wrong: every other field passes through unchanged.
    const body = { status: 'ok', version: '0.12.0', sdkVersion: '0.12.0' };
    expect(hideBuildCommit(body)).toEqual(body);
  });
});

describe('formatHealthSection', () => {
  it('aligns every value at the given column', () => {
    expect(
      formatHealthSection(
        '--- X ---',
        [
          ['A', '1'],
          ['Longer', '2'],
        ],
        10,
      ),
    ).toEqual(['', '--- X ---', 'A:        1', 'Longer:   2']);
  });

  it('never returns the heading alone', () => {
    // fails-when: a body with no recognised field yields a bare heading — the
    // reported defect, reached through a different body.
    const lines = formatHealthSection('--- X ---', [], 10);

    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^Health: {3}\S/);
  });
});

describe('readLocalEndpoint', () => {
  it('reads KICI_PORT, quoted or not, and falls back to the default', () => {
    expect(readLocalEndpoint('KICI_PORT=5555\n', 1).port).toBe(5555);
    expect(readLocalEndpoint('KICI_PORT="6666"\n', 1).port).toBe(6666);
    expect(readLocalEndpoint('', 4321).port).toBe(4321);
    expect(readLocalEndpoint('# KICI_PORT=5555\n', 4321).port).toBe(4321);
    expect(readLocalEndpoint('KICI_PORT=abc\n', 4321).port).toBe(4321);
  });

  it('reaches a wildcard bind on localhost and a single-address bind on that address', () => {
    // fails-when: a service bound to one non-loopback address is still queried
    // on localhost, where nothing listens.
    expect(readLocalEndpoint('', 1).host).toBe('localhost');
    expect(readLocalEndpoint('KICI_HOST=0.0.0.0\n', 1).host).toBe('localhost');
    expect(readLocalEndpoint('KICI_HOST=::\n', 1).host).toBe('localhost');
    expect(readLocalEndpoint('KICI_HOST=10.0.0.5\n', 1).host).toBe('10.0.0.5');
  });

  it('normalises KICI_BASE_PATH to a prefix with one leading slash', () => {
    expect(readLocalEndpoint('', 1).pathPrefix).toBe('');
    expect(readLocalEndpoint('KICI_BASE_PATH=/\n', 1).pathPrefix).toBe('');
    expect(readLocalEndpoint('KICI_BASE_PATH=/orchestrator/\n', 1).pathPrefix).toBe(
      '/orchestrator',
    );
    expect(readLocalEndpoint('KICI_BASE_PATH=kici/orch\n', 1).pathPrefix).toBe('/kici/orch');
  });
});

describe('localUrl', () => {
  it('joins host, port, prefix and path, bracketing an IPv6 host', () => {
    expect(localUrl({ host: 'localhost', port: 4000, pathPrefix: '' }, '/health')).toBe(
      'http://localhost:4000/health',
    );
    expect(localUrl({ host: 'fd00::5', port: 4000, pathPrefix: '/orch' }, '/ready')).toBe(
      'http://[fd00::5]:4000/orch/ready',
    );
  });
});

describe('readEnvContent', () => {
  // fails-when: an env file this account may not read is skipped in silence,
  // and status probes the default port as if the service used it. The read
  // itself fails: in a folder the account may not open, an existence check
  // would call the file missing instead.
  it('warns when the account may not read the env file', () => {
    const warn = vi.fn();
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    try {
      expect(readEnvContent(process.execPath, warn)).toBe('');
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`cannot read ${process.execPath} (EPERM)`),
    );
  });

  // breaks-if-wrong: a readable file is returned, and a missing one is not an error.
  it('reads a readable file and treats a missing one as empty, both without a warning', () => {
    const warn = vi.fn();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-read-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.env'), 'KICI_PORT=4100\n');
      expect(readEnvContent(path.join(dir, 'a.env'), warn)).toBe('KICI_PORT=4100\n');
      expect(readEnvContent(path.join(dir, 'missing.env'), warn)).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
