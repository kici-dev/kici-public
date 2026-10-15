/**
 * Parses a diagnostic ZIP bundle into a structured summary for the inspect-bundle CLI
 * command. Works offline -- no network access or running orchestrator needed.
 */

import * as fs from 'node:fs';
import JSZip from 'jszip';

export interface BundleManifest {
  version: string;
  generated_at: string;
  orchestrator_id?: string;
  source?: string;
  node_version: string;
  platform: string;
}

export interface BundleSummary {
  manifest: BundleManifest;
  checkResults: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    durationMs: number;
  }>;
  /** Number of checks that failed. */
  errorCount: number;
  /** Number of checks that warned. */
  warningCount: number;
  systemInfo: Record<string, unknown>;
  /** Detected config issues (missing required fields, etc.). */
  configIssues: string[];
  /** Present only if logs were included. */
  logSummary?: {
    totalLines: number;
    errors: number;
    warnings: number;
  };
}

export async function readDebugBundle(zipPath: string): Promise<BundleSummary> {
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid debug bundle: missing manifest.json');
  }
  const manifest: BundleManifest = JSON.parse(await manifestFile.async('text'));

  let checkResults: BundleSummary['checkResults'] = [];
  const diagnosticsFile = zip.file('diagnostics/results.json');
  if (diagnosticsFile) {
    const raw = JSON.parse(await diagnosticsFile.async('text'));
    const checks = Array.isArray(raw) ? raw : Array.isArray(raw.checks) ? raw.checks : [];
    if (checks.length > 0) {
      checkResults = checks.map((r: Record<string, unknown>) => ({
        name: String(r.name ?? 'Unknown'),
        status: (r.status as 'pass' | 'warn' | 'fail') ?? 'fail',
        message: String(r.message ?? ''),
        durationMs: Number(r.durationMs ?? 0),
      }));
    }
  }

  const errorCount = checkResults.filter((c) => c.status === 'fail').length;
  const warningCount = checkResults.filter((c) => c.status === 'warn').length;

  let systemInfo: Record<string, unknown> = {};
  const systemFile = zip.file('system/info.json');
  if (systemFile) {
    systemInfo = JSON.parse(await systemFile.async('text'));
  }

  const configIssues: string[] = [];
  const configFile = zip.file('config/config.json');
  if (configFile) {
    const config = JSON.parse(await configFile.async('text'));
    if (!config.mode) configIssues.push('Missing mode in config');
    if (!config.port && config.port !== 0) configIssues.push('Missing port in config');
  } else {
    configIssues.push('No config found in bundle');
  }

  let logSummary: BundleSummary['logSummary'];
  const logSummaryFile = zip.file('logs/summary.json');
  if (logSummaryFile) {
    const raw = JSON.parse(await logSummaryFile.async('text'));
    logSummary = {
      totalLines: Number(raw.totalLines ?? 0),
      errors: Number(raw.errors ?? 0),
      warnings: Number(raw.warnings ?? 0),
    };
  }

  return {
    manifest,
    checkResults,
    errorCount,
    warningCount,
    systemInfo,
    configIssues,
    logSummary,
  };
}
