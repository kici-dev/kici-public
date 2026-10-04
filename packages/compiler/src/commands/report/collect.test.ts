import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DashboardClientError } from '../../remote/dashboard-client.js';
import { createReportBundle, type ReportBundleDeps } from './collect.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-report-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(over: Partial<ReportBundleDeps> = {}): Partial<ReportBundleDeps> {
  return {
    loadConfig: async () => ({ endpoint: 'https://api.example.com', pat: 'kici-pat-secret' }),
    probe: async () => null,
    readProject: async () => ({ workflows: ['build.ts'], lock: { schemaVersion: 3 } }),
    fetchRun: async () => ({ detail: { id: 'run-1', status: 'failed' }, logs: 'plain log line' }),
    now: () => new Date('2026-08-31T12:00:00Z'),
    ...over,
  };
}

async function build(over: Partial<ReportBundleDeps> = {}, opts: Record<string, unknown> = {}) {
  const outputPath = path.join(tmp, 'report.zip');
  const result = await createReportBundle({
    outputPath,
    kiciDir: path.join(tmp, '.kici'),
    metadata: { note: 'hello' },
    redact: true,
    deps: deps(over),
    ...opts,
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const entries: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    entries[name] = await zip.files[name]!.async('string');
  }
  return { result, entries };
}

describe('createReportBundle', () => {
  it('writes the shared archive layout so inspect-bundle can read it', async () => {
    const { entries } = await build();
    expect(Object.keys(entries).sort()).toEqual([
      'config/config.json',
      'identity.json',
      'manifest.json',
      'project/project.json',
      'system/info.json',
    ]);
  });

  it('returns a sha256 that actually matches the file on disk', async () => {
    const { result } = await build();
    // Recompute independently: asserting only the hex SHAPE would pass if
    // digestOf hashed a constant, which is the bug this guards.
    const expected = createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
    expect(result.sha256).toBe(expected);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  it('redacts config values through the allowlist', async () => {
    const { entries } = await build();
    const config = JSON.parse(entries['config/config.json']!);
    // Positive control: the collector really did see the secret-bearing field.
    expect(Object.keys(config)).toContain('pat');
    expect(config.pat).toBe('****');
  });

  it('includes the run material and scrubs secrets out of its logs', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const { entries } = await build(
      { fetchRun: async () => ({ detail: { id: 'r1' }, logs: `failed with ${token}` }) },
      { runId: 'r1' },
    );
    expect(entries['runs/r1/detail.json']).toBeDefined();
    const logs = entries['runs/r1/logs.txt']!;
    // Non-vacuity: the un-scrubbed input contains the token, so the assertion
    // below detects scrubbing rather than an empty log entry.
    expect(`failed with ${token}`).toContain(token);
    expect(logs).not.toContain(token);
    expect(logs).toContain('***REDACTED');
  });

  it('leaves run logs intact when redaction is turned off', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const { entries } = await build(
      { fetchRun: async () => ({ detail: { id: 'r1' }, logs: `failed with ${token}` }) },
      { runId: 'r1', redact: false },
    );
    expect(entries['runs/r1/logs.txt']).toContain(token);
    expect(JSON.parse(entries['manifest.json']!).redacted).toBe(false);
  });

  describe('collection report', () => {
    it('marks a healthy collector ok and records the manifest copy', async () => {
      const { result, entries } = await build();
      const manifest = JSON.parse(entries['manifest.json']!);
      expect(manifest.collectionReport).toEqual(result.collectionReport);
      const config = result.collectionReport.find((e) => e.collector === 'config');
      expect(config).toEqual({ collector: 'config', status: 'ok' });
    });

    it('records a throwing collector as error WITHOUT aborting the bundle', async () => {
      const { result, entries } = await build({
        readProject: async () => {
          throw new Error('ENOENT: .kici is missing');
        },
      });
      const project = result.collectionReport.find((e) => e.collector === 'project');
      expect(project?.status).toBe('error');
      expect(project?.note).toContain('ENOENT');
      // The bundle still exists and still carries every other section.
      expect(entries['manifest.json']).toBeDefined();
      expect(entries['identity.json']).toBeDefined();
      expect(entries['project/project.json']).toBeUndefined();
    });

    it('scrubs a secret out of a collector error message', async () => {
      const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
      const { result } = await build({
        loadConfig: async () => {
          throw new Error(`request failed with token ${token}`);
        },
      });
      const entry = result.collectionReport.find((e) => e.collector === 'config');
      expect(entry?.status).toBe('error');
      expect(entry?.note).not.toContain(token);
    });

    it('distinguishes an empty collector from a healthy one', async () => {
      const { result } = await build({ readProject: async () => null as never });
      expect(result.collectionReport.find((e) => e.collector === 'project')?.status).toBe('empty');
    });

    it('marks the run collector skipped when no run was named', async () => {
      const { result } = await build();
      expect(result.collectionReport.find((e) => e.collector === 'run')).toEqual({
        collector: 'run',
        status: 'skipped',
        note: 'no --run given',
      });
    });

    it('covers every collector exactly once', async () => {
      const { result } = await build();
      const names = result.collectionReport.map((e) => e.collector);
      expect(names).toEqual(['probe', 'identity', 'config', 'project', 'system', 'run']);
    });
  });

  it('carries the caller metadata and a bundle id into the manifest', async () => {
    const { result, entries } = await build();
    const manifest = JSON.parse(entries['manifest.json']!);
    expect(manifest.metadata).toEqual({ note: 'hello' });
    expect(manifest.bundle_id).toBe(result.bundleId);
    expect(manifest.bundle_id).toMatch(/^[0-9a-f]{24}$/);
    expect(manifest.generated_at).toBe('2026-08-31T12:00:00.000Z');
  });

  it('creates the output directory when it does not exist', async () => {
    const outputPath = path.join(tmp, 'nested', 'deep', 'report.zip');
    await createReportBundle({
      outputPath,
      kiciDir: path.join(tmp, '.kici'),
      metadata: {},
      redact: true,
      deps: deps(),
    });
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});

describe('createReportBundle redaction completeness', () => {
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

  it('scrubs the manifest too, so a secret in --metadata cannot ride along', async () => {
    const { entries } = await build({}, { metadata: { ticket: `see ${TOKEN}` } });
    // Non-vacuity: the value really was passed in, so its absence is the
    // scrub working rather than the metadata being dropped.
    const manifest = entries['manifest.json']!;
    expect(manifest).toContain('ticket');
    expect(manifest).not.toContain(TOKEN);
    expect(manifest).toContain('***REDACTED');
  });

  it('leaves the config unredacted when --no-redact is given', async () => {
    // The flag promises an unredacted bundle; leaving the allowlist on
    // regardless made its help text and the published docs wrong.
    const { entries } = await build({}, { redact: false });
    const config = JSON.parse(entries['config/config.json']!);
    expect(config.pat).toBe('kici-pat-secret');
  });

  it('still applies the allowlist when redaction is on', async () => {
    const { entries } = await build();
    expect(JSON.parse(entries['config/config.json']!).pat).toBe('****');
  });

  it('reports an unauthenticated probe as skipped, not as a malfunction', async () => {
    const { result } = await build({ probe: async () => null });
    expect(result.collectionReport.find((e) => e.collector === 'probe')).toEqual({
      collector: 'probe',
      status: 'skipped',
      note: 'not authenticated',
    });
  });

  it('records a throwing probe as an error with a scrubbed note', async () => {
    const { result } = await build({
      probe: async () => {
        throw new Error(`probe failed with ${TOKEN}`);
      },
    });
    const entry = result.collectionReport.find((e) => e.collector === 'probe');
    expect(entry?.status).toBe('error');
    expect(entry?.note).not.toContain(TOKEN);
  });

  it('rejects cleanly when the output path cannot be written', async () => {
    // Without an 'error' listener on the write stream this escalated to an
    // uncaught exception and killed the process.
    const unwritable = path.join(tmp, 'a-file');
    fs.writeFileSync(unwritable, 'not a directory');
    await expect(
      createReportBundle({
        outputPath: path.join(unwritable, 'nested', 'report.zip'),
        kiciDir: path.join(tmp, '.kici'),
        metadata: {},
        redact: true,
        deps: deps(),
      }),
    ).rejects.toThrow();
  });
});

describe('createReportBundle identifying fields', () => {
  const PAT = 'kici_pat_0123abcd0123abcd0123abcd';
  const LOGGED_IN = {
    platformEndpoint: 'https://api.kici.dev',
    oidcIssuer: 'https://auth.kici.dev',
    pat: PAT,
    patId: '6f1c2b0e-8a8d-4c3e-9a51-0d6c1f3e2a77',
    patExpiresAt: '2026-12-31T00:00:00.000Z',
    activeOrgId: 'org_prod00001',
  };
  const loggedIn = async () => ({ ...LOGGED_IN });
  const runNotFound = async (): Promise<never> => {
    throw new DashboardClientError('not_found', 'Run not found', 404);
  };

  it('keeps the endpoint, issuer, org and PAT expiry readable in config.json', async () => {
    const { entries } = await build({ loadConfig: loggedIn });
    const config = JSON.parse(entries['config/config.json']!);
    // fails-when: config.json is built with the plain shared redactConfig.
    expect(config.platformEndpoint).toBe('https://api.kici.dev');
    expect(config.oidcIssuer).toBe('https://auth.kici.dev');
    expect(config.activeOrgId).toBe('org_prod00001');
    expect(config.patExpiresAt).toBe('2026-12-31T00:00:00.000Z');
  });

  it('still masks the PAT and its id', async () => {
    const { entries } = await build({ loadConfig: loggedIn });
    const raw = entries['config/config.json']!;
    const config = JSON.parse(raw);
    // breaks-if-wrong: the readable allowlist must not reach the credential.
    expect(config.pat).toBe('****');
    expect(config.patId).toBe('****');
    expect(raw).not.toContain(PAT);
  });

  it('masks a password embedded in a readable endpoint URL', async () => {
    // The endpoint is readable; the free-text scrubber still runs over it.
    const { entries } = await build({
      loadConfig: async () => ({
        ...LOGGED_IN,
        platformEndpoint: 'https://ops:s3cr3tpassw0rd@api.example.com',
      }),
    });
    const raw = entries['config/config.json']!;
    expect(raw).not.toContain('s3cr3tpassw0rd');
    expect(raw).toContain('api.example.com');
  });

  it('names the searched endpoint and org when the run is not found', async () => {
    const { result, entries } = await build(
      { loadConfig: loggedIn, fetchRun: runNotFound },
      { runId: '0b5e8a4c-1f2d-4e6a-9b7c-3d2e1f0a9b8c' },
    );
    const run = result.collectionReport.find((e) => e.collector === 'run');
    expect(run?.status).toBe('error');
    // fails-when: the run collector records the raw "Run not found" message.
    expect(run?.note).toBe('Run not found (searched org org_prod00001 on https://api.kici.dev)');
    // The manifest copy carries the same note through the scrubber.
    const manifest = JSON.parse(entries['manifest.json']!);
    expect(manifest.collectionReport).toEqual(result.collectionReport);
  });

  it('leaves a non-not-found run error unchanged when the target is known', async () => {
    // The config names an endpoint and an org, so the lookup target exists:
    // only the error kind keeps the note bare.
    // fails-when: the fetch wrapper names the target on every error kind.
    const { result } = await build(
      {
        loadConfig: loggedIn,
        fetchRun: async () => {
          throw new DashboardClientError('forbidden', 'Access denied.', 403);
        },
      },
      { runId: 'r1' },
    );
    expect(result.collectionReport.find((e) => e.collector === 'run')?.note).toBe('Access denied.');
  });

  it('keeps the remedy text of an org-less CLI', async () => {
    // breaks-if-wrong: an org-less CLI keeps its own remedy text.
    const { result } = await build(
      {
        loadConfig: async () => ({ platformEndpoint: 'https://api.kici.dev', pat: PAT }),
        fetchRun: async () => {
          throw new DashboardClientError(
            'no_active_org',
            'No active organization. Run `kici org use <name>` to set one.',
          );
        },
      },
      { runId: 'r1' },
    );
    expect(result.collectionReport.find((e) => e.collector === 'run')?.note).toBe(
      'No active organization. Run `kici org use <name>` to set one.',
    );
  });

  it('still records a found run as ok', async () => {
    // breaks-if-wrong: the fetch wrapper must not swallow a success.
    const { result, entries } = await build({ loadConfig: loggedIn }, { runId: 'r1' });
    expect(result.collectionReport.find((e) => e.collector === 'run')).toEqual({
      collector: 'run',
      status: 'ok',
    });
    expect(entries['runs/r1/detail.json']).toBeDefined();
  });

  it('records a not-found run unchanged when the config could not be read', async () => {
    const { result } = await build(
      {
        loadConfig: async () => {
          throw new Error('Config file contains invalid JSON.');
        },
        fetchRun: runNotFound,
      },
      { runId: 'r1' },
    );
    expect(result.collectionReport.find((e) => e.collector === 'run')?.note).toBe('Run not found');
  });
});
