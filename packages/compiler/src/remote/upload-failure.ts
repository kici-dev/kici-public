/**
 * Turn a failed overlay upload into an error that says which address failed
 * and which orchestrator setting produced it.
 *
 * The upload goes from the developer machine straight to the address the
 * orchestrator signed. When that address is only reachable from inside the
 * orchestrator's network (`host.docker.internal`, an in-cluster DNS name) the
 * raw fetch error says nothing useful. Only the URL's origin is printed: the
 * query string of a presigned URL carries the credential.
 */
import { toErrorMessage } from '@kici-dev/core';

/** Path prefix of the filesystem storage backend's signed blob URLs. */
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
