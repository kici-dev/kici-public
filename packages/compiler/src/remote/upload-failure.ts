/**
 * Names the failed address and the orchestrator setting that produced it. The
 * upload goes straight to the address the orchestrator signed; when that is
 * reachable only inside the orchestrator's network (`host.docker.internal`, an
 * in-cluster DNS name), the raw fetch error says nothing useful. Only the
 * origin is printed: a presigned URL's query string carries the credential.
 */
import { toErrorMessage } from '@kici-dev/core';

/** The filesystem storage backend's signed blob URL prefix. */
const FS_BLOB_PATH_PREFIX = '/api/v1/cache/blob/';

function parse(signedUrl: string): URL | null {
  try {
    return new URL(signedUrl);
  } catch {
    return null;
  }
}

/** Replace every URL query string in free text, so no signature is echoed. */
function scrubQueries(text: string): string {
  return text.replace(/\?[^\s'"]*/g, '?…');
}

export function describeUploadFailure(err: unknown, signedUrl: string): Error {
  const url = parse(signedUrl);
  const target = url ? url.origin : 'the upload address';
  const isFs = url ? url.pathname.startsWith(FS_BLOB_PATH_PREFIX) : false;
  const setting = isFs
    ? 'KICI_STORAGE_FS_BASE_URL'
    : 'KICI_STORAGE_UPLOAD_ENDPOINT (falls back to KICI_STORAGE_EXTERNAL_ENDPOINT, then KICI_STORAGE_ENDPOINT)';
  return new Error(
    `Uploading the working tree to ${target} failed: ${scrubQueries(toErrorMessage(err))}. ` +
      `The orchestrator signs this address from ${setting}; ask its operator to set it to an address this machine can reach.`,
    { cause: err },
  );
}
