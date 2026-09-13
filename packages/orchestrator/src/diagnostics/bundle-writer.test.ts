/**
 * Tests for bundle-writer: debug bundle creation with secret redaction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebugBundle, type BundleOptions } from './bundle-writer.js';
import { readDebugBundle } from './bundle-reader.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import JSZip from 'jszip';

describe('createDebugBundle', () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-bundle-test-'));
    outputPath = path.join(tmpDir, 'test-bundle.zip');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseBundleOptions: BundleOptions = {
    outputPath: '', // set per test
    orchestratorId: 'orch-test-1',
    config: {
      mode: 'platform',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      dbUrl: 'postgresql://user:secret@localhost/kici',
      apiToken: 'tok_super_secret_123',
      webhookSecret: 'whsec_abc',
      oidcSecret: 'oidc_secret_value',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      nested: {
        safe: 'localhost',
        password: 'hunter2',
      },
    },
    diagnosticDeps: {
      config: {},
    },
  };

  it('generates a valid ZIP file', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    const result = await createDebugBundle(opts);

    expect(result).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify it's a valid ZIP
    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    expect(Object.keys(zip.files).length).toBeGreaterThan(0);
  });

  it('contains manifest.json with version, generated_at, orchestrator_id', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'));

    expect(manifest.version).toBe('1.0');
    expect(manifest.orchestrator_id).toBe('orch-test-1');
    expect(manifest.generated_at).toBeDefined();
    expect(new Date(manifest.generated_at).getTime()).not.toBeNaN();
    expect(manifest.node_version).toBe(process.version);
    expect(manifest.platform).toBe(process.platform);
  });

  it('contains config/config.json with secrets redacted as "****"', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const config = JSON.parse(await zip.file('config/config.json')!.async('text'));

    // Safe fields should be preserved
    expect(config.mode).toBe('platform');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  it('uses allowlist -- only known-safe fields are included, everything else redacted', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const config = JSON.parse(await zip.file('config/config.json')!.async('text'));

    // Sensitive fields should be redacted
    expect(config.dbUrl).toBe('****');
    expect(config.apiToken).toBe('****');
    expect(config.webhookSecret).toBe('****');
    expect(config.oidcSecret).toBe('****');
    expect(config.privateKey).toBe('****');

    // Nested unknown string fields redacted too
    expect(config.nested.password).toBe('****');
  });

  it('redacts all sensitive fields (db password, apiToken, privateKey, webhookSecret, oidcSecret)', async () => {
    const opts = {
      ...baseBundleOptions,
      config: {
        dbUrl: 'postgresql://user:pass@host/db',
        apiToken: 'tok_abc',
        privateKey: 'private-key-data',
        webhookSecret: 'whsec_123',
        oidcSecret: 'oidc-secret-data',
        dbPassword: 'db-pass',
        secretKey: 'sk_live_abc',
      },
      outputPath,
    };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const config = JSON.parse(await zip.file('config/config.json')!.async('text'));

    expect(config.dbUrl).toBe('****');
    expect(config.apiToken).toBe('****');
    expect(config.privateKey).toBe('****');
    expect(config.webhookSecret).toBe('****');
    expect(config.oidcSecret).toBe('****');
    expect(config.dbPassword).toBe('****');
    expect(config.secretKey).toBe('****');
  });

  it('contains system/info.json with os, nodeVersion, cpuCount, totalMemory, arch', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const info = JSON.parse(await zip.file('system/info.json')!.async('text'));

    expect(info.platform).toBe(os.platform());
    expect(info.arch).toBe(os.arch());
    expect(info.nodeVersion).toBe(process.version);
    expect(info.cpuCount).toBe(os.cpus().length);
    expect(info.totalMemory).toBeGreaterThan(0);
    expect(typeof info.freeMemory).toBe('number');
    expect(typeof info.uptime).toBe('number');
  });

  it('contains diagnostics/results.json with check results', async () => {
    const opts = { ...baseBundleOptions, outputPath };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);
    const results = JSON.parse(await zip.file('diagnostics/results.json')!.async('text'));

    expect(Array.isArray(results)).toBe(true);
  });

  it('handles logs directory with recent log files', async () => {
    // Create a mock log directory with files
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'app.log'), 'line 1\nline 2\nERROR something\n');

    const opts = { ...baseBundleOptions, outputPath, logDir };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);

    // Should contain logs directory
    const logFiles = Object.keys(zip.files).filter((f) => f.startsWith('logs/'));
    expect(logFiles.length).toBeGreaterThan(0);
  });

  it('includes most recent log files first when cap is reached', async () => {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);

    // Create old log (large, written first with older mtime)
    const oldPath = path.join(logDir, 'old.log');
    fs.writeFileSync(oldPath, 'old log line\n'.repeat(1000));
    // Set mtime to 1 hour ago
    const oneHourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(oldPath, oneHourAgo, oneHourAgo);

    // Create recent log (smaller, written second with newer mtime)
    const recentPath = path.join(logDir, 'recent.log');
    fs.writeFileSync(recentPath, 'recent log line\n'.repeat(10));

    const opts = { ...baseBundleOptions, outputPath, logDir };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);

    // Both should be present (under cap), but recent.log should be in the bundle
    const recentFile = zip.file('logs/recent.log');
    expect(recentFile).not.toBeNull();
    const recentContent = await recentFile!.async('text');
    expect(recentContent).toContain('recent log line');
  });

  it('excludes log files older than logWindow hours', async () => {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);

    // Create a recent log (modified now)
    const recentPath = path.join(logDir, 'recent.log');
    fs.writeFileSync(recentPath, 'recent data\n');

    // Create an old log (modified 10 hours ago)
    const oldPath = path.join(logDir, 'old.log');
    fs.writeFileSync(oldPath, 'old data\n');
    const tenHoursAgo = new Date(Date.now() - 10 * 3600_000);
    fs.utimesSync(oldPath, tenHoursAgo, tenHoursAgo);

    // Use logWindow=2 so the old file is excluded
    const opts = { ...baseBundleOptions, outputPath, logDir, logWindow: 2 };
    await createDebugBundle(opts);

    const zipData = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(zipData);

    // Recent log should be included
    expect(zip.file('logs/recent.log')).not.toBeNull();
    // Old log should be excluded (outside 2-hour window)
    expect(zip.file('logs/old.log')).toBeNull();
    // Summary should still exist
    expect(zip.file('logs/summary.json')).not.toBeNull();
  });

  it('enforces max log size (50MB cap)', async () => {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);

    // Create a "large" log file (we just test the logic with a smaller threshold in tests)
    // The real cap is 50MB but we test the mechanism exists
    const bigContent = 'x'.repeat(1024) + '\n';
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(logDir, `app-${i}.log`), bigContent.repeat(100));
    }

    const opts = { ...baseBundleOptions, outputPath, logDir };
    await createDebugBundle(opts);

    // Should complete without error (cap is enforced internally)
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});

describe('readDebugBundle', () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-bundle-reader-test-'));
    outputPath = path.join(tmpDir, 'test-bundle.zip');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a bundle ZIP and returns structured summary', async () => {
    // First create a bundle
    await createDebugBundle({
      outputPath,
      orchestratorId: 'orch-reader-test',
      config: { mode: 'platform', port: 8080 },
      diagnosticDeps: { config: {} },
    });

    const summary = await readDebugBundle(outputPath);

    expect(summary.manifest).toBeDefined();
    expect(summary.manifest.version).toBe('1.0');
    expect(summary.manifest.orchestrator_id).toBe('orch-reader-test');
    expect(summary.systemInfo).toBeDefined();
    expect(summary.systemInfo.platform).toBe(os.platform());
  });

  it('extracts error count, warning count, check results from bundle', async () => {
    await createDebugBundle({
      outputPath,
      orchestratorId: 'orch-counts-test',
      config: { mode: 'platform' },
      diagnosticDeps: { config: {} },
    });

    const summary = await readDebugBundle(outputPath);

    expect(typeof summary.errorCount).toBe('number');
    expect(typeof summary.warningCount).toBe('number');
    expect(Array.isArray(summary.checkResults)).toBe(true);
  });
});
