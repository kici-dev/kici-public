/**
 * Opaque pagination cursors for the dashboard list handlers:
 * base64url(JSON(fields)), every field a string.
 */

/** Encode `fields` as a cursor. Key order follows the object literal. */
export function encodeCursor(fields: Record<string, string>): string {
  return Buffer.from(JSON.stringify(fields), 'utf-8').toString('base64url');
}

/**
 * Decode a cursor into exactly `keys`. Returns null when the cursor is not
 * base64url JSON or any key is missing or not a string; other keys are dropped.
 */
export function decodeCursor<K extends string>(
  raw: string,
  keys: readonly K[],
): Record<K, string> | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    const fields = {} as Record<K, string>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value !== 'string') return null;
      fields[key] = value;
    }
    return fields;
  } catch {
    return null;
  }
}
