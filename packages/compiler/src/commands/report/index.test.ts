import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultOutputPath,
  parseMetadata,
  reportCommand,
  reportListCommand,
  reportWithdrawCommand,
} from './index.js';
import type { ReportBundleDeps } from './collect.js';
import type { UploadDeps } from './upload.js';

let tmp: string;
let logged: string[];
let warned: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-report-cmd-'));
  logged = [];
  warned = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void logged.push(String(m)));
  vi.spyOn(console, 'warn').mockImplementation((m: string) => void warned.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: string) => void warned.push(String(m)));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function bundleDeps(over: Partial<ReportBundleDeps> = {}): Partial<ReportBundleDeps> {
  return {
    loadConfig: async () => ({ endpoint: 'https://api.example.com' }),
    probe: async () => null,
    readProject: async () => ({ workflows: [] }),
    fetchRun: async () => ({ detail: {}, logs: '' }),
    now: () => new Date('2026-08-31T12:00:00Z'),
    ...over,
  };
}

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    output: path.join(tmp, 'r.zip'),
    metadata: [] as string[],
    redact: true,
    kiciDir: path.join(tmp, '.kici'),
    deps: bundleDeps(),
    ...over,
  };
}

describe('parseMetadata', () => {
  it('parses repeatable key=value pairs', () => {
    expect(parseMetadata(['a=1', 'b=two'])).toEqual({ a: '1', b: 'two' });
  });

  it('keeps an = inside the value', () => {
    expect(parseMetadata(['q=a=b'])).toEqual({ q: 'a=b' });
  });

  it('rejects a pair with no key', () => {
    expect(() => parseMetadata(['=v'])).toThrow(/expected key=value/);
  });

  it('rejects a pair with no separator', () => {
    expect(() => parseMetadata(['novalue'])).toThrow(/expected key=value/);
  });
});

describe('defaultOutputPath', () => {
  it('is timestamped and absolute so two reports never collide', () => {
    const p = defaultOutputPath(new Date('2026-08-31T12:00:00Z'));
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toMatch(/kici-report-2026-08-31T12-00-00-000\.zip$/);
  });
});

describe('reportCommand', () => {
  it('writes the bundle and prints its path, digest and file count', async () => {
    const ok = await reportCommand(baseOptions());
    expect(ok).toBe(true);
    const out = logged.join('\n');
    expect(out).toContain(path.join(tmp, 'r.zip'));
    expect(out).toMatch(/sha256: [0-9a-f]{64}/);
    expect(out).toMatch(/file\(s\) collected/);
    expect(fs.existsSync(path.join(tmp, 'r.zip'))).toBe(true);
  });

  it('prints the best-effort redaction notice so nobody over-trusts the bundle', async () => {
    await reportCommand(baseOptions());
    expect(logged.join('\n')).toMatch(/Redaction is best effort/i);
  });

  it('warns loudly when redaction is disabled, and drops the reassuring notice', async () => {
    await reportCommand(baseOptions({ redact: false }));
    expect(warned.join('\n')).toMatch(/WARNING/);
    expect(warned.join('\n')).toMatch(/secrets in plain text/i);
    expect(logged.join('\n')).not.toMatch(/Redaction is best effort/i);
  });

  it('names the collectors that came back thin rather than only counting them', async () => {
    await reportCommand(
      baseOptions({
        deps: bundleDeps({
          readProject: async () => {
            throw new Error('boom');
          },
        }),
      }),
    );
    expect(logged.join('\n')).toMatch(/incomplete:.*project \(error\)/);
  });

  it('does NOT upload unless --upload is given', async () => {
    const putBytes = vi.fn();
    await reportCommand(
      baseOptions({
        uploadDeps: {
          createIssueReport: vi.fn(),
          confirmIssueReport: vi.fn(),
          putBytes,
        } as unknown as UploadDeps,
      }),
    );
    expect(putBytes).not.toHaveBeenCalled();
    expect(logged.join('\n')).toMatch(/kici report --upload/);
  });

  it('uploads and prints the reference id when --upload is given', async () => {
    const createIssueReport = vi.fn(async () => ({ ref: 'ref-123', uploadUrl: 'https://put' }));
    const putBytes = vi.fn(async () => {});
    const confirmIssueReport = vi.fn(async () => ({ ref: 'ref-123', status: 'received' }));

    const ok = await reportCommand(
      baseOptions({
        upload: true,
        message: 'it broke',
        uploadDeps: { createIssueReport, putBytes, confirmIssueReport } as unknown as UploadDeps,
      }),
    );

    expect(ok).toBe(true);
    expect(createIssueReport).toHaveBeenCalledOnce();
    expect(putBytes).toHaveBeenCalledOnce();
    expect(confirmIssueReport).toHaveBeenCalledWith('ref-123');
    expect(logged.join('\n')).toContain('ref-123');
  });

  it('uploads the exact bytes it promised at presign time', async () => {
    let promised = -1;
    let sent = -1;
    await reportCommand(
      baseOptions({
        upload: true,
        uploadDeps: {
          createIssueReport: async (b: { byteSize: number }) => {
            promised = b.byteSize;
            return { ref: 'r', uploadUrl: 'https://put' };
          },
          putBytes: async (_u: string, body: Buffer) => {
            sent = body.byteLength;
          },
          confirmIssueReport: async () => ({ ref: 'r', status: 'received' }),
        } as unknown as UploadDeps,
      }),
    );
    expect(promised).toBeGreaterThan(0);
    expect(sent).toBe(promised);
  });

  it('returns false on a bad --metadata pair instead of writing a bundle', async () => {
    const ok = await reportCommand(baseOptions({ metadata: ['oops'] }));
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'r.zip'))).toBe(false);
  });

  it('returns false when the upload fails', async () => {
    const ok = await reportCommand(
      baseOptions({
        upload: true,
        uploadDeps: {
          createIssueReport: async () => {
            throw new Error('Platform said no');
          },
          putBytes: async () => {},
          confirmIssueReport: async () => ({ ref: '', status: '' }),
        } as unknown as UploadDeps,
      }),
    );
    expect(ok).toBe(false);
    // The local bundle still landed, so the diagnostic work is not lost.
    expect(fs.existsSync(path.join(tmp, 'r.zip'))).toBe(true);
  });
});

describe('reportListCommand', () => {
  const row = {
    ref: 'r1',
    bundleId: 'b1',
    byteSize: 10,
    status: 'received',
    createdAt: '2026-08-31T00:00:00.000Z',
    userId: 'u1',
    message: null,
  };

  it('prints one line per report', async () => {
    const ok = await reportListCommand({
      deps: { listIssueReports: async () => ({ reports: [row] }) },
    });
    expect(ok).toBe(true);
    expect(logged.join('\n')).toContain('r1');
    expect(logged.join('\n')).toContain('received');
  });

  it('emits raw JSON under --json', async () => {
    await reportListCommand({
      json: true,
      deps: { listIssueReports: async () => ({ reports: [row] }) },
    });
    expect(JSON.parse(logged.join('\n'))).toEqual({ reports: [row] });
  });

  it('says so plainly when there are none', async () => {
    await reportListCommand({ deps: { listIssueReports: async () => ({ reports: [] }) } });
    expect(logged.join('\n')).toMatch(/No issue reports/i);
  });

  it('returns false when the list call fails', async () => {
    const ok = await reportListCommand({
      deps: {
        listIssueReports: async () => {
          throw new Error('nope');
        },
      },
    });
    expect(ok).toBe(false);
  });
});

describe('reportWithdrawCommand', () => {
  it('withdraws the named report and confirms the bundle is gone', async () => {
    const withdrawIssueReport = vi.fn(async () => ({ ref: 'r1', deleted: true }));
    const ok = await reportWithdrawCommand({ ref: 'r1', deps: { withdrawIssueReport } });
    expect(ok).toBe(true);
    expect(withdrawIssueReport).toHaveBeenCalledWith('r1');
    expect(logged.join('\n')).toMatch(/withdrawn/i);
  });

  it('returns false when the withdraw call fails', async () => {
    const ok = await reportWithdrawCommand({
      ref: 'r1',
      deps: {
        withdrawIssueReport: async () => {
          throw new Error('not found');
        },
      },
    });
    expect(ok).toBe(false);
  });
});

describe('reportCommand safety guards', () => {
  it('refuses --no-redact together with --upload', async () => {
    const putBytes = vi.fn();
    const ok = await reportCommand(
      baseOptions({
        redact: false,
        upload: true,
        uploadDeps: {
          createIssueReport: vi.fn(),
          confirmIssueReport: vi.fn(),
          putBytes,
        } as unknown as UploadDeps,
      }),
    );
    // The docs say --no-redact is for a bundle you keep; uploading one would
    // send plaintext secrets to KiCI, which no warning makes safe.
    expect(ok).toBe(false);
    expect(putBytes).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'r.zip'))).toBe(false);
  });

  it('still allows --no-redact on its own', async () => {
    const ok = await reportCommand(baseOptions({ redact: false }));
    expect(ok).toBe(true);
    expect(warned.join('\n')).toMatch(/WARNING/);
  });
});

describe('parseMetadata prototype safety', () => {
  it('stores a __proto__ pair as an ordinary key instead of dropping it', async () => {
    const parsed = parseMetadata(['__proto__=evil', 'ok=1']);
    expect(Object.keys(parsed).sort()).toEqual(['__proto__', 'ok']);
    // And it did not pollute the prototype chain.
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('reportWithdrawCommand honesty', () => {
  it('reports failure when the Platform says the bundle was NOT deleted', async () => {
    const ok = await reportWithdrawCommand({
      ref: 'r1',
      deps: { withdrawIssueReport: async () => ({ ref: 'r1', deleted: false }) },
    });
    expect(ok).toBe(false);
    expect(logged.join('\n')).not.toMatch(/withdrawn/i);
  });
});
