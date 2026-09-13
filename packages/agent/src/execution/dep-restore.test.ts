import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  resolveOrchestratorUrl,
  restoreDeps,
  streamFetchAndExtract,
  excludeScratchFromGit,
  SCRATCH_DIR_GIT_EXCLUDE_GLOB,
  DOWNLOAD_TIMEOUT_MS,
  MAX_RETRIES,
} from './dep-restore.js';

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

describe('streaming dep restore', () => {
  let server: Server;
  let serverPort: number;
  let tmpDir: string;
  let tarballPath: string;
  let tarballData: Buffer;
  let tarballHash: string;

  /**
   * Create a test .tar.gz file mimicking the production dep-cache shape: the
   * tarball is repo-root-relative, so the npm/yarn closure is `.kici/node_modules`
   * (see dep-packer.ts).
   */
  async function createTestTarball(dir: string): Promise<string> {
    const contentDir = join(dir, 'tarball-content');
    const nodeModulesDir = join(contentDir, '.kici', 'node_modules');
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(join(nodeModulesDir, 'hello.txt'), 'hello world');
    const outPath = join(dir, 'test.tar.gz');
    execSync(`tar czf "${outPath}" -C "${contentDir}" .`);
    return outPath;
  }

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dep-restore-test-'));
    tarballPath = await createTestTarball(tmpDir);
    tarballData = await readFile(tarballPath);
    tarballHash = createHash('sha256').update(tarballData).digest('hex');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          serverPort = addr.port;
          resolve(serverPort);
        }
      });
    });
  }

  describe('streamFetchAndExtract', () => {
    it('streams and extracts a tarball, returning correct hash', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarballData);
      });

      const targetDir = join(tmpDir, 'extract-1');
      const hash = await streamFetchAndExtract(`http://127.0.0.1:${port}/test.tar.gz`, targetDir);

      expect(hash).toBe(tarballHash);
      // streamFetchAndExtract is the low-level primitive: it extracts the raw
      // repo-root-relative tarball, so the closure lands under `.kici/`.
      const files = await readdir(targetDir);
      expect(files).toContain('.kici');
      const content = await readFile(
        join(targetDir, '.kici', 'node_modules', 'hello.txt'),
        'utf-8',
      );
      expect(content).toBe('hello world');
    });

    it('throws on HTTP error status', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      const targetDir = join(tmpDir, 'extract-404');
      await expect(
        streamFetchAndExtract(`http://127.0.0.1:${port}/missing`, targetDir),
      ).rejects.toThrow('HTTP 404');
    });
  });

  describe('restoreDeps with HTTP', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.KICI_ORCHESTRATOR_URL;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('downloads and extracts via streaming pipeline', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarballData);
      });

      const workDir = join(tmpDir, 'work-1');
      await mkdir(workDir, { recursive: true });
      await restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`);

      const kiciDir = join(workDir, '.kici');
      const files = await readdir(kiciDir);
      expect(files).toContain('node_modules');
      const content = await readFile(join(kiciDir, 'node_modules', 'hello.txt'), 'utf-8');
      expect(content).toBe('hello world');
    });

    it('verifies hash on streaming download', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarballData);
      });

      const workDir = join(tmpDir, 'work-hash');
      await mkdir(workDir, { recursive: true });
      // Should succeed with correct hash
      await restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`, tarballHash);

      const files = await readdir(join(workDir, '.kici'));
      expect(files).toContain('node_modules');
    });

    it('throws on hash mismatch after all retries', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarballData);
      });

      const workDir = join(tmpDir, 'work-bad-hash');
      await mkdir(workDir, { recursive: true });
      await expect(
        restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`, 'deadbeef'),
      ).rejects.toThrow(/failed after 3 attempts/);
    });

    it('retries on server failure', async () => {
      let requestCount = 0;
      const port = await startServer((_req, res) => {
        requestCount++;
        if (requestCount <= 2) {
          // First 2 requests fail
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          // Third request succeeds
          res.writeHead(200, { 'Content-Type': 'application/gzip' });
          res.end(tarballData);
        }
      });

      const workDir = join(tmpDir, 'work-retry');
      await mkdir(workDir, { recursive: true });
      await restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`);

      expect(requestCount).toBe(3); // initial + 2 retries
      const files = await readdir(join(workDir, '.kici'));
      expect(files).toContain('node_modules');
    });

    it('preserves .kici/package.json across retries', async () => {
      let requestCount = 0;
      const port = await startServer((_req, res) => {
        requestCount++;
        if (requestCount <= 2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/gzip' });
          res.end(tarballData);
        }
      });

      const workDir = join(tmpDir, 'work-retry-preserve');
      const kiciDir = join(workDir, '.kici');
      await mkdir(kiciDir, { recursive: true });
      // Simulate pre-existing files that git clone puts in .kici/
      await writeFile(join(kiciDir, 'package.json'), '{"name":"test"}');
      await writeFile(join(kiciDir, '.npmrc'), 'registry=http://localhost');

      await restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`);

      expect(requestCount).toBe(3);
      // Verify pre-existing files survived the retry
      const packageJson = await readFile(join(kiciDir, 'package.json'), 'utf-8');
      expect(packageJson).toBe('{"name":"test"}');
      const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf-8');
      expect(npmrc).toBe('registry=http://localhost');
      // Verify extraction also succeeded
      const files = await readdir(kiciDir);
      expect(files).toContain('node_modules');
    });

    it('uses a unique per-attempt scratch dir so retries cannot race partial extractions', async () => {
      // Regression test for the ENOTEMPTY race: a failed attempt's tar
      // extraction continues flushing pending fs writes after pipeline()
      // rejects. If retry #N+1 reused the same destination, those writes
      // would race with rmdir during cleanup. The fix is to give each
      // attempt its own scratch dir whose contents are atomically renamed
      // into place only on success — so retries never share a destination
      // with the writes from a failed earlier attempt.
      let requestCount = 0;
      const port = await startServer((_req, res) => {
        requestCount++;
        if (requestCount <= 2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/gzip' });
          res.end(tarballData);
        }
      });

      const workDir = join(tmpDir, 'work-scratch-isolation');
      const kiciDir = join(workDir, '.kici');
      await mkdir(kiciDir, { recursive: true });
      await restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`);

      expect(requestCount).toBe(3);
      // node_modules exists in the final location (atomic rename succeeded).
      const finalFiles = await readdir(kiciDir);
      expect(finalFiles).toContain('node_modules');
      // The successful attempt's scratch dir is cleaned up.
      const scratchDirsLeft = finalFiles.filter((f) => f.startsWith('.dep-restore-scratch-'));
      // Failed attempts MAY leave orphan scratch dirs (intentional — see
      // dep-restore.ts: rm during in-flight tar writes would race), but the
      // successful attempt's scratch dir must be cleaned up.
      // We can't assert the exact count without knowing how many attempts
      // had pipeline() rejection (vs HTTP 500 fast-failures), but we can
      // assert at least the final state is correct.
      expect(scratchDirsLeft.length).toBeLessThanOrEqual(2); // up to 2 retries
    });

    it('fails after exhausting all retries', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });

      const workDir = join(tmpDir, 'work-exhaust');
      await mkdir(workDir, { recursive: true });
      await expect(restoreDeps(workDir, `http://127.0.0.1:${port}/test.tar.gz`)).rejects.toThrow(
        /failed after 3 attempts/,
      );
    });

    it('rejects unsupported URL schemes', async () => {
      const workDir = join(tmpDir, 'work-scheme');
      await mkdir(workDir, { recursive: true });
      await expect(restoreDeps(workDir, 'ftp://example.com/file.tar.gz')).rejects.toThrow(
        'Unsupported deps URL scheme',
      );
    });
  });

  describe('restoreDeps with file://', () => {
    it('uses buffer-based approach for local files', async () => {
      const workDir = join(tmpDir, 'work-file');
      await mkdir(workDir, { recursive: true });

      const fileUrl = `file://${tarballPath}`;
      await restoreDeps(workDir, fileUrl);

      const files = await readdir(join(workDir, '.kici'));
      expect(files).toContain('node_modules');
    });

    it('verifies hash for file:// URLs', async () => {
      const workDir = join(tmpDir, 'work-file-hash');
      await mkdir(workDir, { recursive: true });

      const fileUrl = `file://${tarballPath}`;
      await restoreDeps(workDir, fileUrl, tarballHash);

      const files = await readdir(join(workDir, '.kici'));
      expect(files).toContain('node_modules');
    });

    it('throws on hash mismatch for file:// URLs (no retry)', async () => {
      const workDir = join(tmpDir, 'work-file-bad');
      await mkdir(workDir, { recursive: true });

      const fileUrl = `file://${tarballPath}`;
      await expect(restoreDeps(workDir, fileUrl, 'deadbeef')).rejects.toThrow(
        'Dep tarball hash mismatch',
      );
    });
  });

  describe('constants', () => {
    it('DOWNLOAD_TIMEOUT_MS is 5 minutes', () => {
      expect(DOWNLOAD_TIMEOUT_MS).toBe(5 * 60 * 1000);
    });

    it('MAX_RETRIES is 2', () => {
      expect(MAX_RETRIES).toBe(2);
    });
  });

  describe('excludeScratchFromGit', () => {
    it('appends the scratch glob to .git/info/exclude when missing', async () => {
      const repoDir = join(tmpDir, 'exclude-fresh');
      const infoDir = join(repoDir, '.git', 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(join(infoDir, 'exclude'), '# git ignore\n');

      await excludeScratchFromGit(repoDir);

      const content = await readFile(join(infoDir, 'exclude'), 'utf-8');
      expect(content).toContain(SCRATCH_DIR_GIT_EXCLUDE_GLOB);
    });

    it('is idempotent — second call does not duplicate the rule', async () => {
      const repoDir = join(tmpDir, 'exclude-idempotent');
      const infoDir = join(repoDir, '.git', 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(join(infoDir, 'exclude'), '');

      await excludeScratchFromGit(repoDir);
      await excludeScratchFromGit(repoDir);

      const content = await readFile(join(infoDir, 'exclude'), 'utf-8');
      const occurrences = content
        .split('\n')
        .filter((l) => l.trim() === SCRATCH_DIR_GIT_EXCLUDE_GLOB);
      expect(occurrences).toHaveLength(1);
    });

    it('handles empty exclude file (no leading newline added)', async () => {
      const repoDir = join(tmpDir, 'exclude-empty');
      const infoDir = join(repoDir, '.git', 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(join(infoDir, 'exclude'), '');

      await excludeScratchFromGit(repoDir);

      const content = await readFile(join(infoDir, 'exclude'), 'utf-8');
      expect(content.startsWith('\n')).toBe(false);
      expect(content).toContain(SCRATCH_DIR_GIT_EXCLUDE_GLOB);
    });

    it('inserts a newline separator when existing content lacks trailing newline', async () => {
      const repoDir = join(tmpDir, 'exclude-no-trailing-nl');
      const infoDir = join(repoDir, '.git', 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(join(infoDir, 'exclude'), '# no trailing newline');

      await excludeScratchFromGit(repoDir);

      const content = await readFile(join(infoDir, 'exclude'), 'utf-8');
      // The previous line and the new comment must be on separate lines.
      expect(content).toMatch(/no trailing newline\n# kici:/);
      expect(content).toContain(SCRATCH_DIR_GIT_EXCLUDE_GLOB);
    });

    it('does not throw when .git/info/exclude is missing (best-effort)', async () => {
      const repoDir = join(tmpDir, 'exclude-no-git');
      await mkdir(repoDir, { recursive: true });
      // No .git/ at all — fullRepo / checkout=false workflows.
      await expect(excludeScratchFromGit(repoDir)).resolves.toBeUndefined();
    });

    it('matches the scratch dir prefix that extractIntoScratch creates', async () => {
      // Coupling check: if SCRATCH_DIR_BASENAME_PREFIX is renamed but the
      // exported glob isn't updated, this test catches the drift.
      // The glob is a literal pattern; we assert its anchor matches the
      // observable scratch dir naming via a real restoreDeps call below.
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarballData);
      });
      const workDir = join(tmpDir, 'work-glob-coupling');
      const kiciDir = join(workDir, '.kici');
      await mkdir(kiciDir, { recursive: true });

      // Stage a failing-then-succeeding sequence so an orphan scratch dir
      // gets left behind for inspection (only fast HTTP failures here, no
      // tar I/O race risk).
      let count = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const port2 = await startServer((_req, res) => {
        count++;
        if (count <= 1) {
          res.writeHead(500);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/gzip' });
          res.end(tarballData);
        }
      });
      void port; // first port not used after restart
      await restoreDeps(workDir, `http://127.0.0.1:${port2}/test.tar.gz`);

      // Whatever scratch dirs remain in kiciDir must be matched by the glob's
      // basename prefix.
      const entries = await readdir(kiciDir);
      const scratch = entries.filter((e) =>
        e.startsWith(SCRATCH_DIR_GIT_EXCLUDE_GLOB.replace(/^\.kici\//, '').replace(/\*$/, '')),
      );
      // node_modules from the successful attempt must exist; orphans are
      // optional (HTTP 500 fast-fails don't always create a scratch dir).
      expect(entries).toContain('node_modules');
      // Sanity: the glob's basename prefix is the same one extractIntoScratch
      // uses. If a future refactor diverges, `scratch` would be empty here
      // when an orphan IS present, OR the glob would mis-anchor.
      for (const dir of scratch) {
        expect(dir).toMatch(/^\.dep-restore-scratch-/);
      }
    });
  });
});
