/**
 * Upload a report bundle privately to KiCI.
 *
 * Three steps, and the split is the point: the Platform mints a presigned PUT,
 * the bytes go straight from this machine to object storage, and a confirm call
 * lets the Platform verify what actually landed. The bundle never transits the
 * control plane, and the Platform never takes the client's word for the size.
 *
 * Upload is always opt-in (`--upload`). A bundle contains diagnostic data from
 * the customer's own machine, so sending it is a separate, explicit act from
 * producing it.
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DashboardClient } from '../../remote/dashboard-client.js';

export interface UploadMeta {
  bundleId: string;
  message?: string;
  email?: string;
}

export interface UploadDeps {
  createIssueReport: DashboardClient['createIssueReport'];
  confirmIssueReport: DashboardClient['confirmIssueReport'];
  /** PUT the bundle bytes at the presigned URL. */
  putBytes: (url: string, body: Buffer) => Promise<void>;
}

/** sha256 of the file, which the Platform records alongside the report. */
export function sha256Of(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

async function defaultPutBytes(url: string, body: Buffer): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    // The presign signed this exact length; a mismatch is rejected by the store.
    headers: { 'Content-Length': String(body.byteLength) },
  });
  if (!res.ok) {
    throw new Error(`Bundle upload failed (${res.status} ${res.statusText}).`);
  }
}

async function defaultDeps(): Promise<UploadDeps> {
  const client = await DashboardClient.load();
  return {
    createIssueReport: client.createIssueReport.bind(client),
    confirmIssueReport: client.confirmIssueReport.bind(client),
    putBytes: defaultPutBytes,
  };
}

/**
 * Upload one bundle and return the reference id to quote to support.
 *
 * Reads the file once and derives both the size and the digest from those same
 * bytes, so what is promised at presign time is necessarily what is uploaded —
 * a stat-then-read would race a file still being written.
 */
export async function uploadReportBundle(
  zipPath: string,
  meta: UploadMeta,
  deps?: UploadDeps,
): Promise<{ ref: string; status: string }> {
  const resolved = deps ?? (await defaultDeps());
  const body = fs.readFileSync(zipPath);

  const { ref, uploadUrl } = await resolved.createIssueReport({
    bundleId: meta.bundleId,
    byteSize: body.byteLength,
    sha256: sha256Of(body),
    message: meta.message,
    email: meta.email,
  });

  await resolved.putBytes(uploadUrl, body);

  const confirmed = await resolved.confirmIssueReport(ref);
  return { ref, status: confirmed.status };
}
