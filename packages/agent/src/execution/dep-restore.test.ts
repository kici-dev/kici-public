import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  resolveOrchestratorUrl,
  restoreDeps,
  excludeScratchFromGit,
  SCRATCH_DIR_GIT_EXCLUDE_GLOB,
  DEFAULT_DEP_RESTORE_LIMITS,
} from './dep-restore.js';
import { DepRestoreError, DepTarballHashMismatchError } from './dep-restore-errors.js';
import { DepRestoreOutcome } from './dep-restore-report.js';

describe('resolveOrchestratorUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes through non-localhost URLs unchanged', () => {
    expect(resolveOrchestratorUrl('http://example.com:3900/path')).toBe(
      'http://example.com:3900/path',
    );
  });

  it('passes through file:// URLs unchanged', () => {
    expect(resolveOrchestratorUrl('file:///tmp/cache/tarball.tar.gz')).toBe(
      'file:///tmp/cache/tarball.tar.gz',
    );
  });

  it('rewrites localhost URLs when KICI_ORCHESTRATOR_URL is set', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orchestrator-host:9090';
    expect(resolveOrchestratorUrl('http://localhost:3900/bucket/key')).toBe(
      'http://orchestrator-host:3900/bucket/key',
    );
  });

  it('rewrites 127.0.0.1 URLs when KICI_ORCHESTRATOR_URL is set', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orchestrator-host:9090';
    expect(resolveOrchestratorUrl('http://127.0.0.1:3900/bucket/key')).toBe(
      'http://orchestrator-host:3900/bucket/key',
    );
  });

  it('keeps localhost URLs unchanged when KICI_ORCHESTRATOR_URL is not set', () => {
    delete process.env.KICI_ORCHESTRATOR_URL;
    expect(resolveOrchestratorUrl('http://localhost:3900/bucket/key')).toBe(
      'http://localhost:3900/bucket/key',
    );
  });

  it('keeps 127.0.0.1 URLs unchanged when KICI_ORCHESTRATOR_URL is not set', () => {
    delete process.env.KICI_ORCHESTRATOR_URL;
    expect(resolveOrchestratorUrl('http://127.0.0.1:3900/bucket/key')).toBe(
      'http://127.0.0.1:3900/bucket/key',
    );
  });

  it('preserves the original port (not the WS port)', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orch-host:8080';
    expect(resolveOrchestratorUrl('http://localhost:5555/path')).toBe('http://orch-host:5555/path');
  });

  it('handles https URLs', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'wss://orch-host:443';
    expect(resolveOrchestratorUrl('https://localhost:3900/bucket/key')).toBe(
      'https://orch-host:3900/bucket/key',
    );
  });

  it('handles 127.0.0.1 with https', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'wss://orch-host:443';
    expect(resolveOrchestratorUrl('https://127.0.0.1:3900/bucket/key')).toBe(
      'https://orch-host:3900/bucket/key',
    );
  });

  it('does not match 127.0.0.2 or other loopback addresses', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orch-host:8080';
    expect(resolveOrchestratorUrl('http://127.0.0.2:3900/path')).toBe('http://127.0.0.2:3900/path');
  });
});

/** Temp roots restoreDeps left at the repository root. */
async function tempRoots(workDir: string): Promise<string[]> {
  return (await readdir(workDir)).filter((e) => e.startsWith('.kici-dep-restore-'));
}

describe('restoreDeps', () => {
  let server: Server | undefined;
  let tmpDir: string;
  let tarballPath: string;
  let tarballData: Buffer;
  let tarballHash: string;
  let requests: number;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dep-restore-test-'));
    const contentDir = join(tmpDir, 'tarball-content');
    await mkdir(join(contentDir, '.kici', 'node_modules'), { recursive: true });
    await writeFile(join(contentDir, '.kici', 'node_modules', 'hello.txt'), 'hello world');
    tarballPath = join(tmpDir, 'test.tar.gz');
    execSync(`tar czf "${tarballPath}" -C "${contentDir}" .`);
    tarballData = await readFile(tarballPath);
    tarballHash = createHash('sha256').update(tarballData).digest('hex');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KICI_ORCHESTRATOR_URL;
    requests = 0;
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<string> {
    server = createServer((req, res) => {
      requests++;
      handler(req, res);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    return `http://127.0.0.1:${addr.port}/test.tar.gz?X-Amz-Signature=secret`;
  }

  const ok = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    res.end(tarballData);
  };

  async function workDir(name: string): Promise<string> {
    const d = join(tmpDir, name);
    await mkdir(join(d, '.kici'), { recursive: true });
    return d;
  }

  it('downloads, verifies and extracts over HTTP', async () => {
    const url = await startServer(ok);
    const dir = await workDir('work-http');
    const report = await restoreDeps(dir, url, tarballHash);

    expect(await readFile(join(dir, '.kici', 'node_modules', 'hello.txt'), 'utf-8')).toBe(
      'hello world',
    );
    expect(report).toMatchObject({
      outcome: DepRestoreOutcome.enum.restored,
      verified: true,
      tarballBytes: tarballData.length,
    });
    // The signature never reaches a log line.
    expect(report.source).not.toContain('X-Amz-Signature');
    expect(await tempRoots(dir)).toEqual([]);
  });

  it('restores without a hash, unverified', async () => {
    const url = await startServer(ok);
    const dir = await workDir('work-no-hash');
    const report = await restoreDeps(dir, url);
    expect(report.verified).toBe(false);
    expect(await readdir(join(dir, '.kici'))).toContain('node_modules');
  });

  it('fails a hash mismatch after one download, before extracting anything', async () => {
    // fails-when: the mismatch is retried as a download failure, or tar.x ran before the check
    // breaks-if-wrong: a matching hash restores (first test)
    const url = await startServer(ok);
    const dir = await workDir('work-bad-hash');
    const err = await restoreDeps(dir, url, 'deadbeef').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DepTarballHashMismatchError);
    expect((err as Error).message).toBe(
      `Dep tarball hash mismatch: expected deadbeef, got ${tarballHash}`,
    );
    expect((err as DepRestoreError).report.outcome).toBe(DepRestoreOutcome.enum['hash-mismatch']);
    expect(requests).toBe(1);
    expect(await readdir(join(dir, '.kici'))).toEqual([]);
    expect(await tempRoots(dir)).toEqual([]);
  });

  it('retries a server failure and preserves the files already in .kici/', async () => {
    const url = await startServer((req, res) => {
      if (requests <= 2) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      ok(req, res);
    });
    const dir = await workDir('work-retry');
    await writeFile(join(dir, '.kici', 'package.json'), '{"name":"test"}');
    const progress: string[] = [];
    const report = await restoreDeps(dir, url, tarballHash, {
      limits: { retryBaseDelayMs: 1 },
      onProgress: (line) => progress.push(line),
    });

    expect(requests).toBe(3);
    expect(report.attempts.map((a) => a.status)).toEqual([500, 500, 200]);
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatch(/^Dep tarball download attempt 1\/3 failed after .*: HTTP 500;/);
    expect(await readFile(join(dir, '.kici', 'package.json'), 'utf-8')).toBe('{"name":"test"}');
    expect(await readdir(join(dir, '.kici'))).toContain('node_modules');
  });

  it('fails after the attempt budget and leaves no temp root', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const dir = await workDir('work-exhaust');
    const err = await restoreDeps(dir, url, tarballHash, {
      limits: { retryBaseDelayMs: 1 },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DepRestoreError);
    expect((err as Error).message).toBe(
      'Dep tarball download failed: Download failed after 3 attempts: HTTP 500',
    );
    expect((err as DepRestoreError).report.outcome).toBe(DepRestoreOutcome.enum['download-failed']);
    expect(await tempRoots(dir)).toEqual([]);
  });

  it('rejects unsupported URL schemes', async () => {
    const dir = await workDir('work-scheme');
    const err = await restoreDeps(dir, 'ftp://example.com/file.tar.gz').catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'Unsupported deps URL scheme: ftp://example.com/file.tar.gz',
    );
    expect((err as DepRestoreError).report.outcome).toBe(DepRestoreOutcome.enum['unsupported-url']);
  });

  it('reads a file:// tarball in place, verifies it, and never deletes it', async () => {
    const dir = await workDir('work-file');
    const report = await restoreDeps(dir, `file://${tarballPath}`, tarballHash);
    expect(report).toMatchObject({ verified: true, attempts: [] });
    expect(await readdir(join(dir, '.kici'))).toContain('node_modules');
    expect(await readFile(tarballPath)).toEqual(tarballData);
  });

  it('fails a file:// hash mismatch', async () => {
    const dir = await workDir('work-file-bad');
    await expect(restoreDeps(dir, `file://${tarballPath}`, 'deadbeef')).rejects.toBeInstanceOf(
      DepTarballHashMismatchError,
    );
  });

  it('pins the extraction bound', () => {
    expect(DEFAULT_DEP_RESTORE_LIMITS.extractTimeoutMs).toBe(600_000);
  });
});

describe('excludeScratchFromGit', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dep-restore-exclude-'));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function repo(name: string, exclude: string): Promise<string> {
    const dir = join(tmpDir, name);
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeFile(join(dir, '.git', 'info', 'exclude'), exclude);
    return dir;
  }

  it('appends the temp-root glob once', async () => {
    const dir = await repo('fresh', '# git ignore\n');
    await excludeScratchFromGit(dir);
    await excludeScratchFromGit(dir);
    const lines = (await readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8')).split('\n');
    expect(lines.filter((l) => l === SCRATCH_DIR_GIT_EXCLUDE_GLOB)).toHaveLength(1);
  });

  it('inserts a newline when the file lacks a trailing one', async () => {
    const dir = await repo('no-nl', '# no trailing newline');
    await excludeScratchFromGit(dir);
    expect(await readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toMatch(
      /no trailing newline\n# kici:/,
    );
  });

  it('does not throw when .git/info/exclude is missing', async () => {
    const dir = join(tmpDir, 'no-git');
    await mkdir(dir, { recursive: true });
    await expect(excludeScratchFromGit(dir)).resolves.toBeUndefined();
  });

  it('matches the temp root restoreDeps creates, anchored at the repo root', async () => {
    // fails-when: the prefix and the glob drift apart and a leftover shows in git status
    const dir = join(tmpDir, 'git');
    await mkdir(dir, { recursive: true });
    execSync('git init -q', { cwd: dir });
    await excludeScratchFromGit(dir);
    await mkdir(join(dir, '.kici-dep-restore-123-456', 'extract'), { recursive: true });
    await writeFile(join(dir, '.kici-dep-restore-123-456', 'deps.tar.gz'), 'x');
    await mkdir(join(dir, 'sub', '.kici-dep-restore-1'), { recursive: true });
    await writeFile(join(dir, 'sub', '.kici-dep-restore-1', 'f'), 'x');
    const status = execSync('git status --porcelain --untracked-files=all', {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.kici-dep-restore-123-456');
    // Anchored: the same name below the root is ordinary content.
    expect(status).toContain('sub/.kici-dep-restore-1/f');
  });
});
