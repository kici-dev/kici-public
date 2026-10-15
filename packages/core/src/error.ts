/** Human-readable message of an unknown thrown value. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Serialize an error for logging: message, type name, `code`, response
 * `status` and details, and the chained `cause`. An empty `err.message` falls
 * back to a shape descriptor: an empty message is a debugging dead end, and
 * a library has thrown sync failures with no message but a populated `.code` /
 * `.response.status`.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err === null || err === undefined) {
    return { message: String(err) };
  }
  if (typeof err !== 'object') {
    return { message: String(err) };
  }

  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const rawMessage = err instanceof Error ? err.message : (e.message as string | undefined);
  out.message = rawMessage && rawMessage.length > 0 ? rawMessage : `<${describeShape(err)}>`;

  if (err instanceof Error && err.name && err.name !== 'Error') {
    out.name = err.name;
  }

  if (typeof e.code === 'string' || typeof e.code === 'number') {
    out.code = e.code;
  }

  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response === 'object') {
    if (typeof response.status === 'number') out.status = response.status;
    if (response.statusText) out.statusText = response.statusText;
    if (response.data !== undefined) out.responseData = trimResponseData(response.data);
  }

  if (e.cause !== undefined) {
    out.cause = serializeError(e.cause);
  }

  return out;
}

/** Describe an error's shape when its `.message` is empty. */
function describeShape(err: object): string {
  const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
  if (ctor && ctor !== 'Object') return `${ctor} with empty message`;
  const keys = Object.keys(err).slice(0, 5).join(',');
  return keys ? `object{${keys}}` : 'empty error';
}

/** Cap response payload size to keep logs readable. */
function trimResponseData(data: unknown): unknown {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  if (s.length <= 500) return data;
  return s.slice(0, 500) + `…(+${s.length - 500} chars)`;
}
