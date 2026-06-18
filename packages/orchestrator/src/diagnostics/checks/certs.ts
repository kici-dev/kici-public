/**
 * TLS certificate expiry diagnostic check.
 *
 * Reads a TLS certificate from the configured path and checks
 * the not-after date. Warns if expiring within 30 days, fails if expired.
 */

import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

const WARN_DAYS = 30;

export async function checkCertificateExpiry(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  if (!deps.tlsCertPath) {
    return {
      name: 'TLS certificate',
      status: 'pass',
      message: 'No TLS cert path configured (using HTTP)',
      durationMs: Date.now() - start,
    };
  }

  try {
    const pem = await readFile(deps.tlsCertPath, 'utf-8');
    const cert = new X509Certificate(pem);
    const notAfter = new Date(cert.validTo);
    const now = new Date();
    const daysLeft = Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const durationMs = Date.now() - start;

    if (daysLeft < 0) {
      return {
        name: 'TLS certificate',
        status: 'fail',
        message: `Certificate expired ${Math.abs(daysLeft)} days ago`,
        details: { notAfter: notAfter.toISOString(), daysLeft },
        durationMs,
      };
    }

    if (daysLeft < WARN_DAYS) {
      return {
        name: 'TLS certificate',
        status: 'warn',
        message: `Certificate expires in ${daysLeft} days`,
        details: { notAfter: notAfter.toISOString(), daysLeft },
        durationMs,
      };
    }

    return {
      name: 'TLS certificate',
      status: 'pass',
      message: `Certificate valid for ${daysLeft} days`,
      details: { notAfter: notAfter.toISOString(), daysLeft },
      durationMs,
    };
  } catch (err) {
    return {
      name: 'TLS certificate',
      status: 'fail',
      message: `Certificate check failed: ${toErrorMessage(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
