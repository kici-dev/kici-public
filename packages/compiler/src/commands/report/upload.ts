/**
 * Private, opt-in (`--upload`) bundle upload. The Platform mints a presigned
 * PUT, the bytes go straight to object storage, and a confirm call lets the
 * Platform verify what landed: the bundle never transits the control plane, and
 * the Platform never trusts the client's size.
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
  putBytes: (url: string, body: Buffer) => Promise<void>;
}

/** The Platform records it alongside the report. */
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
 * Returns the reference id to quote to support. Size and digest come from one
 * read, so the presign promise matches the upload; stat-then-read would race a
 * file still being written.
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
